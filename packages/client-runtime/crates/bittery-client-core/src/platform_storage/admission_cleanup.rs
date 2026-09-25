//! One fresh typed read keeps the exact raw value for guarded destination retirement.
use super::*;

pub(crate) struct AdmissionDocumentEvidence {
    pub(crate) raw: SecretString,
    pub(crate) canonical: Zeroizing<Vec<u8>>,
}
fn canonical<T: DeserializeOwned + Serialize>(
    raw: &str,
    validate: impl FnOnce(&T) -> Result<(), RuntimeError>,
) -> Result<Zeroizing<Vec<u8>>, RuntimeError> {
    let Object(document): Object<T> = serde_json::from_str(raw)
        .map_err(|_| platform_storage_invariant("Admission destination document is invalid"))?;
    validate(&document)?;
    serde_json::to_vec(&document)
        .map(Zeroizing::new)
        .map_err(|_| platform_storage_invariant("Admission destination cannot serialize"))
}
fn binding(
    account: &AccountId,
    incarnation: &Incarnation,
    actual_account: &AccountId,
    actual_incarnation: &Incarnation,
) -> Result<(), RuntimeError> {
    require_matching_account(account, actual_account, "Admission destination")?;
    require_matching_incarnation(incarnation, actual_incarnation, "Admission destination")
}
impl PlatformStorage {
    pub(crate) async fn delete_profile_admission_document(
        &self,
        target: &PlatformStorageValue,
        expected: SecretString,
    ) -> Result<PlatformStorageDeleteResult, RuntimeError> {
        if matches!(
            target,
            PlatformStorageValue::DeviceCatalog | PlatformStorageValue::VerifiedRecipientKeys(..)
        ) {
            return Err(platform_storage_invariant(
                "Admission cleanup cannot own this document",
            ));
        }
        let response = self
            .invoke(PlatformStorageRequest::DeleteIfUnchanged {
                area: target.area(self.session_survives_restart),
                key: target.key()?,
                expected_value: expected,
            })
            .await?;
        match response {
            PlatformStorageResponse::DeleteResult { result } => Ok(result),
            _ => Err(platform_storage_invariant(
                "Guarded admission deletion returned another response",
            )),
        }
    }
    pub(crate) async fn profile_admission_document_evidence(
        &self,
        target: &PlatformStorageValue,
    ) -> Result<Option<AdmissionDocumentEvidence>, RuntimeError> {
        if matches!(
            target,
            PlatformStorageValue::DeviceCatalog | PlatformStorageValue::VerifiedRecipientKeys(..)
        ) {
            return Err(platform_storage_invariant(
                "Admission cleanup cannot own this document",
            ));
        }
        let Some(raw) = self.get(target.clone()).await? else {
            return Ok(None);
        };
        let bytes = match target {
            PlatformStorageValue::DeviceKey => {
                canonical(&raw, |value: &DeviceKeyDocument| value.validate())?
            }
            PlatformStorageValue::LocalSecurity => {
                canonical(&raw, |value: &LocalSecurityDocument| {
                    require_version(value.version, "Local security")
                })?
            }
            PlatformStorageValue::AccountLocalSecurity(_) => {
                canonical(&raw, |value: &AccountLocalSecurityDocument| {
                    require_version(value.version, "Account local security")
                })?
            }
            PlatformStorageValue::AccountMetadata(account, incarnation) => {
                canonical(&raw, |value: &AccountMetadataDocument| {
                    value.validate()?;
                    binding(account, incarnation, &value.account_id, &value.incarnation)
                })?
            }
            PlatformStorageValue::AccountQuickUnlock(account, incarnation) => {
                canonical(&raw, |value: &QuickUnlockDocument| {
                    value.validate()?;
                    binding(account, incarnation, &value.account_id, &value.incarnation)
                })?
            }
            PlatformStorageValue::CurrentSessionCredentials(account, incarnation) => {
                canonical(&raw, |value: &CurrentSessionDocument| {
                    value.validate()?;
                    binding(account, incarnation, &value.account_id, &value.incarnation)
                })?
            }
            PlatformStorageValue::LegacySessionEvidence(account, incarnation) => {
                canonical(&raw, |value: &LegacySessionEvidenceDocument| {
                    value.validate()?;
                    binding(account, incarnation, &value.account_id, &value.incarnation)
                })?
            }
            PlatformStorageValue::DeviceCatalog
            | PlatformStorageValue::VerifiedRecipientKeys(..) => {
                unreachable!("catalog is not a staging document")
            }
        };
        Ok(Some(AdmissionDocumentEvidence {
            raw: SecretString::new(raw.to_string()),
            canonical: bytes,
        }))
    }
}
