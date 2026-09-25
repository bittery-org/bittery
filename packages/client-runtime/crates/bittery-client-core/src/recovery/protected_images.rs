//! Only artifact keys cross the authenticated archive boundary; ciphertext is never decrypted here.
use super::{
    artifacts::ImageMetadata,
    capture::Snapshot,
    report::{Findings, RecoveryFinding},
    transfer::{invalid, RecoveryPort},
};
use crate::vault_image::protected::recovery::{export_key, PortableImageKey};
use crate::{platform_storage::DeviceKeyDocument, RuntimeError, RuntimeErrorCode};

pub(super) async fn export_device_key(
    port: &RecoveryPort,
    snapshot: &Snapshot,
    findings: &mut Findings,
) -> Result<Option<DeviceKeyDocument>, RuntimeError> {
    let Some(selected) = snapshot
        .selection
        .as_ref()
        .filter(|selected| !selected.protected_images.is_empty())
    else {
        return Ok(None);
    };
    let key = match port.image_device_key().await {
        Ok(key) => Some(key),
        Err(error) if error.code == RuntimeErrorCode::Cancelled => return Err(error),
        Err(_) => None,
    };
    for (operation, publication) in &selected.protected_images {
        let available = match (
            &key,
            snapshot.artifacts.image_metadata(operation, publication),
        ) {
            (Some(key), Some(metadata)) => portable_key(snapshot, metadata, key).is_ok(),
            _ => false,
        };
        if !available {
            findings.push(RecoveryFinding::UnavailableVaultImageKey {
                operation_id: operation.clone(),
            });
        }
    }
    Ok(key)
}
pub(super) fn portable_key(
    snapshot: &Snapshot,
    metadata: &ImageMetadata,
    device_key: &DeviceKeyDocument,
) -> Result<PortableImageKey, RuntimeError> {
    let proof = snapshot.proof.as_ref().ok_or_else(invalid)?;
    let expected = proof
        .required_images
        .iter()
        .find(|required| required.operation_id == metadata.operation_id)
        .ok_or_else(invalid)?;
    let witness = expected
        .image
        .protected_witness
        .as_ref()
        .ok_or_else(invalid)?;
    export_key(
        &metadata.original()?,
        &proof.head.user_id,
        witness,
        metadata.protection.as_ref().ok_or_else(invalid)?,
        device_key.key_bytes.as_ref(),
    )
}
