mod abort;
mod reset;
pub(crate) use abort::{AbortAccountField, AbortCleanupTarget};
pub(crate) use reset::{ProfileResetScope, ResetPhase};
// Durable admission identity and progress belong to the Device catalog.
use super::{platform_storage_invariant, DeviceCatalogAccount};
use crate::{
    profile_admission::{
        LegacyProfileFormat, ProfileAccountCredentialField, ProfileGlobalCredentialField,
        ProfileSourceFamily, ProfileSourceManifestEntry, ProfileSourceManifestHeader,
        ProfileSourceObservation, ProfileSourceSelector,
    },
    protocol::Incarnation,
    AccountId, RuntimeError,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    remote = "Self",
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ProfileAdmissionRecord {
    Reset {
        version: u32,
        wipe_id: String,
        #[serde(with = "crate::wire::decimal_u64")]
        revision: u64,
        phase: ResetPhase,
        scope: ProfileResetScope,
        remaining_families: Vec<ProfileSourceFamily>,
    },
    Import {
        version: u32,
        admission_id: String,
        #[serde(with = "crate::wire::decimal_u64")]
        revision: u64,
        phase: ImportPhase,
        source: AdmissionSourceIdentity,
        manifest_digest: String,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "deserialize_present"
        )]
        legacy_presentation: Option<LegacyPresentation>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "deserialize_present"
        )]
        progress: Option<Box<AdmissionProgress>>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "deserialize_present"
        )]
        completion_id: Option<String>,
    },
}

pub(crate) use crate::protocol::ProfileAdmissionImportPhase as ImportPhase;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AdmissionSourceIdentity {
    pub(crate) format: LegacyProfileFormat,
    pub(crate) profile_identity: String,
    pub(crate) recorded_capture_id: String,
}

/// Presentation evidence can outlive removal of its selected Account; it never selects an absent one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LegacyPresentation {
    #[serde(deserialize_with = "super::required_option::deserialize")]
    pub(crate) selected_account_id: Option<AccountId>,
    #[serde(deserialize_with = "super::required_option::deserialize")]
    pub(crate) sync_client_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AdmissionManifest {
    pub(crate) header: ProfileSourceManifestHeader,
    pub(crate) entries: Vec<ProfileSourceManifestEntry>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AdmissionProgress {
    pub(crate) manifest: AdmissionManifest,
    pub(crate) accounts: Vec<AdmissionAccount>,
    pub(crate) device: AdmissionDevice,
    pub(crate) source_cleanup: Vec<SourceCleanup>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_present"
    )]
    pub(crate) abort_remaining: Option<Vec<AbortCleanupTarget>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AdmissionAccount {
    pub(crate) account_id: AccountId,
    pub(crate) normalized_server_url: String,
    pub(crate) user_id: String,
    pub(crate) incarnation: Incarnation,
    pub(crate) expected_prior: ExpectedAbsent,
    pub(crate) session: SessionDisposition,
    pub(crate) expected: AccountExpectations,
    pub(crate) checkpoint: AccountCheckpoint,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ExpectedAbsent {
    Absent,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    remote = "Self",
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum SessionDisposition {
    AbsentAtCapture {},
    IncompleteRetained {
        #[serde(deserialize_with = "super::required_option::deserialize")]
        source_session_instance: Option<String>,
    },
    Complete {
        #[serde(deserialize_with = "super::required_option::deserialize")]
        source_session_instance: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AccountExpectations {
    pub(crate) metadata_sha256: String,
    pub(crate) quick_unlock_sha256: String,
    #[serde(deserialize_with = "super::required_option::deserialize")]
    pub(crate) current_session_sha256: Option<String>,
    #[serde(deserialize_with = "super::required_option::deserialize")]
    pub(crate) legacy_session_evidence_sha256: Option<String>,
    pub(crate) account_security_sha256: String,
    #[serde(with = "crate::wire::decimal_u64")]
    pub(crate) replica_revision: u64,
    #[serde(with = "crate::wire::decimal_u64")]
    pub(crate) row_count: u64,
    pub(crate) rows_sha256: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AccountCheckpoint {
    Unwritten,
    Verified,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    remote = "Self",
    tag = "type",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum OriginalDocument {
    Absent {},
    Matching { sha256: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AdmissionDevice {
    // Original absence owns a matching staged write even when its reply was lost.
    pub(crate) original_key: OriginalDocument,
    #[serde(deserialize_with = "super::required_option::deserialize")]
    pub(crate) device_key_sha256: Option<String>,
    pub(crate) original_global_security: OriginalDocument,
    pub(crate) global_security_sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceCleanup {
    #[serde(with = "crate::wire::decimal_u64")]
    pub(crate) manifest_entry_index: u64,
    pub(crate) disposition: CleanupDisposition,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CleanupDisposition {
    Pending,
    Absent,
}

crate::wire::map_only_serde!(
    ProfileAdmissionRecord,
    AdmissionSourceIdentity,
    LegacyPresentation,
    AdmissionManifest,
    AdmissionProgress,
    AdmissionAccount,
    SessionDisposition,
    AccountExpectations,
    OriginalDocument,
    AdmissionDevice,
    SourceCleanup
);

pub(crate) fn identity(value: &str) -> Result<(), RuntimeError> {
    if value.is_empty() || value.len() > crate::PROFILE_SOURCE_IDENTITY_BYTES {
        Err(platform_storage_invariant(
            "Profile admission identity is invalid",
        ))
    } else {
        Ok(())
    }
}

pub(crate) fn digest(value: &str) -> Result<(), RuntimeError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Err(platform_storage_invariant(
            "Profile admission digest is invalid",
        ))
    } else {
        Ok(())
    }
}

impl ProfileAdmissionRecord {
    pub(crate) fn preparing(
        admission_id: String,
        progress: AdmissionProgress,
        legacy_presentation: LegacyPresentation,
    ) -> Self {
        let header = &progress.manifest.header;
        Self::Import {
            version: 1,
            admission_id,
            revision: 0,
            phase: ImportPhase::Preparing,
            source: AdmissionSourceIdentity {
                format: header.format,
                profile_identity: header.profile_identity.clone(),
                recorded_capture_id: header.recorded_capture_id.clone(),
            },
            manifest_digest: header.entries_sha256.clone(),
            legacy_presentation: Some(legacy_presentation),
            progress: Some(Box::new(progress)),
            completion_id: None,
        }
    }
    pub(crate) fn admission_id(&self) -> Option<&str> {
        match self {
            Self::Import { admission_id, .. } => Some(admission_id),
            Self::Reset { .. } => None,
        }
    }
    pub(crate) fn pending_cleanup_obligations(&self) -> Option<u64> {
        (self.phase() == Some(ImportPhase::Committed)).then(|| {
            self.progress()
                .expect("validated Committed progress")
                .source_cleanup
                .iter()
                .filter(|entry| entry.disposition == CleanupDisposition::Pending)
                .count() as u64
        })
    }
    pub(crate) fn record_cleanup(
        &mut self,
        index: u64,
        disposition: CleanupDisposition,
    ) -> Result<bool, RuntimeError> {
        if self.phase() != Some(ImportPhase::Committed) {
            return Err(platform_storage_invariant(
                "Source cleanup requires Committed admission",
            ));
        }
        let entry = self
            .progress_mut()
            .and_then(|progress| {
                progress
                    .source_cleanup
                    .iter_mut()
                    .find(|entry| entry.manifest_entry_index == index)
            })
            .ok_or_else(|| platform_storage_invariant("Source cleanup target is not owned"))?;
        if entry.disposition == disposition {
            return Ok(false);
        }
        entry.disposition = disposition;
        self.advance(ImportPhase::Committed)?;
        Ok(true)
    }
    pub(crate) fn complete_cleanup(&mut self, completion: String) -> Result<(), RuntimeError> {
        identity(&completion)?;
        if self.phase() != Some(ImportPhase::Committed)
            || self.progress().is_none_or(|progress| {
                progress
                    .source_cleanup
                    .iter()
                    .any(|entry| entry.disposition != CleanupDisposition::Absent)
            })
        {
            return Err(platform_storage_invariant("Source cleanup is not complete"));
        }
        let Self::Import {
            phase,
            revision,
            progress,
            completion_id,
            ..
        } = self
        else {
            return Err(platform_storage_invariant(
                "Import admission record is missing",
            ));
        };
        *revision = revision
            .checked_add(1)
            .ok_or_else(|| platform_storage_invariant("Profile admission revision overflows"))?;
        *phase = ImportPhase::Complete;
        *progress = None;
        *completion_id = Some(completion);
        Ok(())
    }
    pub(crate) fn phase(&self) -> Option<ImportPhase> {
        match self {
            Self::Import { phase, .. } => Some(*phase),
            Self::Reset { .. } => None,
        }
    }
    pub(crate) fn progress(&self) -> Option<&AdmissionProgress> {
        let Self::Import { progress, .. } = self else {
            return None;
        };
        progress.as_deref()
    }
    pub(crate) fn progress_mut(&mut self) -> Option<&mut AdmissionProgress> {
        let Self::Import { progress, .. } = self else {
            return None;
        };
        progress.as_deref_mut()
    }
    pub(crate) fn advance(&mut self, next_phase: ImportPhase) -> Result<(), RuntimeError> {
        let Self::Import {
            phase, revision, ..
        } = self
        else {
            return Err(platform_storage_invariant(
                "Import admission record is missing",
            ));
        };
        if !matches!(
            (*phase, next_phase),
            (
                ImportPhase::Preparing,
                ImportPhase::Preparing | ImportPhase::Committed
            ) | (ImportPhase::Preparing, ImportPhase::Aborting)
                | (
                    ImportPhase::Aborting,
                    ImportPhase::Aborting | ImportPhase::Aborted
                )
                | (ImportPhase::Committed, ImportPhase::Committed)
        ) {
            return Err(platform_storage_invariant(
                "Profile admission transition is invalid",
            ));
        }
        *revision = revision
            .checked_add(1)
            .ok_or_else(|| platform_storage_invariant("Profile admission revision overflows"))?;
        *phase = next_phase;
        Ok(())
    }
    pub(crate) fn is_complete(&self) -> bool {
        self.phase() == Some(ImportPhase::Complete)
    }
    pub(crate) fn validate(
        &self,
        catalog_accounts: &[DeviceCatalogAccount],
    ) -> Result<(), RuntimeError> {
        if matches!(self, Self::Reset { .. }) {
            return self.validate_reset(catalog_accounts);
        }
        let Self::Import {
            version,
            admission_id,
            phase,
            source,
            manifest_digest,
            legacy_presentation,
            progress,
            completion_id,
            ..
        } = self
        else {
            return self.validate_reset(catalog_accounts);
        };
        if *version != 1 {
            return Err(platform_storage_invariant(
                "Profile admission version is unsupported",
            ));
        }
        for value in [
            admission_id,
            &source.profile_identity,
            &source.recorded_capture_id,
        ] {
            identity(value)?;
        }
        digest(manifest_digest)?;
        if let Some(presentation) = legacy_presentation {
            if let Some(account) = &presentation.selected_account_id {
                identity(account.as_str())?;
            }
            if let Some(client) = &presentation.sync_client_id {
                super::require_non_empty(client, "legacy Sync client identity")?;
            }
        }
        match (phase, progress, completion_id) {
            (ImportPhase::Complete, None, Some(completion)) => identity(completion),
            (
                ImportPhase::Preparing
                | ImportPhase::Aborting
                | ImportPhase::Aborted
                | ImportPhase::Committed,
                Some(progress),
                None,
            ) => {
                if source.format != LegacyProfileFormat::DesktopLegacyV1 {
                    return Err(platform_storage_invariant(
                        "Profile admission progress format is unsupported",
                    ));
                }
                let header = &progress.manifest.header;
                if header.format != source.format
                    || header.profile_identity != source.profile_identity
                    || header.recorded_capture_id != source.recorded_capture_id
                    || header.entries_sha256 != *manifest_digest
                {
                    return Err(platform_storage_invariant(
                        "Profile admission source identity disagrees with its manifest",
                    ));
                }
                progress.validate(*phase, catalog_accounts)?;
                progress.validate_abort(*phase, catalog_accounts)?;
                if *phase == ImportPhase::Preparing
                    && legacy_presentation
                        .as_ref()
                        .and_then(|value| value.selected_account_id.as_ref())
                        .is_some_and(|selected| {
                            !progress
                                .accounts
                                .iter()
                                .any(|account| &account.account_id == selected)
                        })
                {
                    return Err(platform_storage_invariant(
                        "Profile admission selected Account is outside its mapping",
                    ));
                }
                Ok(())
            }
            _ => Err(platform_storage_invariant(
                "Profile admission phase fields are inconsistent",
            )),
        }
    }
}

impl AdmissionProgress {
    fn validate(
        &self,
        phase: ImportPhase,
        catalog: &[DeviceCatalogAccount],
    ) -> Result<(), RuntimeError> {
        let header = &self.manifest.header;
        let mut manifest_digest = header.digest()?;
        for entry in &self.manifest.entries {
            manifest_digest.append(entry)?;
        }
        if !header.verify_digest(manifest_digest)? {
            return Err(platform_storage_invariant(
                "Profile admission manifest digest disagrees",
            ));
        }
        let mut account_ids = HashSet::new();
        let mut bindings = HashSet::new();
        let mut incarnations = HashSet::new();
        for account in &self.accounts {
            identity(account.account_id.as_str())?;
            identity(account.incarnation.as_str())?;
            super::require_non_empty(&account.user_id, "admission Account User identity")?;
            super::require_non_empty(
                &account.normalized_server_url,
                "admission Account Server identity",
            )?;
            if !account_ids.insert(&account.account_id)
                || !bindings.insert((&account.normalized_server_url, &account.user_id))
                || !incarnations.insert(&account.incarnation)
            {
                return Err(platform_storage_invariant(
                    "Profile admission Account mapping is duplicated",
                ));
            }
            let expected = &account.expected;
            for value in [
                &expected.metadata_sha256,
                &expected.quick_unlock_sha256,
                &expected.account_security_sha256,
                &expected.rows_sha256,
            ] {
                digest(value)?;
            }
            for value in [
                &expected.current_session_sha256,
                &expected.legacy_session_evidence_sha256,
            ]
            .into_iter()
            .flatten()
            {
                digest(value)?;
            }
            if matches!(account.session, SessionDisposition::Complete { .. })
                != expected.current_session_sha256.is_some()
                || expected.current_session_sha256.is_some()
                    == expected.legacy_session_evidence_sha256.is_some()
            {
                return Err(platform_storage_invariant(
                    "Profile admission credential disposition disagrees",
                ));
            }
            if let SessionDisposition::Complete {
                source_session_instance: Some(instance),
            }
            | SessionDisposition::IncompleteRetained {
                source_session_instance: Some(instance),
            } = &account.session
            {
                identity(instance)?;
                return Err(platform_storage_invariant(
                    "Desktop admission cannot retain a browser Session instance",
                ));
            }
            if phase == ImportPhase::Committed && account.checkpoint != AccountCheckpoint::Verified
            {
                return Err(platform_storage_invariant(
                    "Committed profile admission has an unverified Account",
                ));
            }
            if matches!(phase, ImportPhase::Preparing | ImportPhase::Aborting) {
                let entry = catalog
                    .iter()
                    .find(|entry| entry.account_id == account.account_id)
                    .ok_or_else(|| {
                        platform_storage_invariant("Preparing admission lost its pending Account")
                    })?;
                if entry.active_incarnation.is_some()
                    || entry.pending_retirement.is_some()
                    || entry.pending_install.as_ref().is_none_or(|pending| {
                        pending.incarnation != account.incarnation
                            || pending.expected_active_incarnation.is_some()
                    })
                {
                    return Err(platform_storage_invariant(
                        "Preparing admission Account reservation disagrees",
                    ));
                }
            }
        }
        // After commit, ordinary replacement/removal may evolve catalog Accounts independently.
        if matches!(phase, ImportPhase::Preparing | ImportPhase::Aborting)
            && catalog.len() != self.accounts.len()
        {
            return Err(platform_storage_invariant(
                "Preparing admission has an unexplained catalog Account",
            ));
        }
        let mut sorted: Vec<_> = self.accounts.iter().collect();
        sorted.sort_by(|a, b| {
            a.account_id
                .as_str()
                .as_bytes()
                .cmp(b.account_id.as_str().as_bytes())
        });
        let mut selectors = vec![
            (
                ProfileSourceFamily::DesktopStore,
                ProfileSourceSelector::WholeFile {},
            ),
            (
                ProfileSourceFamily::DesktopSyncStore,
                ProfileSourceSelector::WholeFile {},
            ),
            (
                ProfileSourceFamily::DesktopCredentials,
                ProfileSourceSelector::GlobalCredential {
                    field: ProfileGlobalCredentialField::DeviceKey,
                },
            ),
        ];
        for account in &sorted {
            for field in [
                ProfileAccountCredentialField::SecretKey,
                ProfileAccountCredentialField::SessionData,
                ProfileAccountCredentialField::JwtToken,
                ProfileAccountCredentialField::VaultKeys,
                ProfileAccountCredentialField::EncryptedPrivateKey,
            ] {
                selectors.push((
                    ProfileSourceFamily::DesktopCredentials,
                    ProfileSourceSelector::AccountCredential {
                        account_id: account.account_id.clone(),
                        field,
                    },
                ));
            }
        }
        if self.manifest.entries.len() != selectors.len()
            || self
                .manifest
                .entries
                .iter()
                .zip(selectors)
                .any(|(entry, (family, selector))| {
                    entry.family != family || entry.selector != selector
                })
        {
            return Err(platform_storage_invariant(
                "Profile admission manifest coverage disagrees with its Accounts",
            ));
        }
        if matches!(
            self.manifest.entries[2].observation,
            ProfileSourceObservation::StoredString { .. }
        ) != self.device.device_key_sha256.is_some()
        {
            return Err(platform_storage_invariant(
                "Admission Device key disposition disagrees with source evidence",
            ));
        }
        for (index, account) in sorted.iter().enumerate() {
            let segment = &self.manifest.entries[3 + index * 5..3 + (index + 1) * 5];
            let fragments = segment[2..]
                .iter()
                .filter(|entry| {
                    matches!(
                        entry.observation,
                        ProfileSourceObservation::StoredString { .. }
                    )
                })
                .count();
            let disposition_agrees = match account.session {
                SessionDisposition::AbsentAtCapture {} => fragments == 0,
                SessionDisposition::IncompleteRetained { .. } => (1..=2).contains(&fragments),
                SessionDisposition::Complete { .. } => fragments == 3,
            };
            if segment[..2].iter().any(|entry| {
                !matches!(
                    entry.observation,
                    ProfileSourceObservation::StoredString { .. }
                )
            }) || !disposition_agrees
                || segment[2..].iter().any(|entry| {
                    !matches!(
                        entry.observation,
                        ProfileSourceObservation::StoredString { .. }
                            | ProfileSourceObservation::Missing {}
                    )
                })
            {
                return Err(platform_storage_invariant(
                    "Admission credentials disagree with their complete source segment",
                ));
            }
        }
        let obligations: Vec<_> = self
            .manifest
            .entries
            .iter()
            .enumerate()
            .filter(|(_, entry)| !matches!(entry.observation, ProfileSourceObservation::Missing {}))
            .map(|(index, _)| index as u64)
            .collect();
        if obligations.len() != self.source_cleanup.len()
            || self
                .source_cleanup
                .iter()
                .zip(obligations)
                .any(|(cleanup, index)| {
                    cleanup.manifest_entry_index != index
                        || (phase == ImportPhase::Preparing
                            && cleanup.disposition != CleanupDisposition::Pending)
                })
        {
            return Err(platform_storage_invariant(
                "Profile admission source cleanup coverage is inconsistent",
            ));
        }
        digest(&self.device.global_security_sha256)?;
        for (original, expected) in [
            (
                &self.device.original_key,
                self.device.device_key_sha256.as_deref(),
            ),
            (
                &self.device.original_global_security,
                Some(self.device.global_security_sha256.as_str()),
            ),
        ] {
            if let Some(expected) = expected {
                digest(expected)?;
            }
            if let OriginalDocument::Matching { sha256 } = original {
                digest(sha256)?;
                if Some(sha256.as_str()) != expected {
                    return Err(platform_storage_invariant(
                        "Profile admission original Device document disagrees",
                    ));
                }
            }
        }
        if !self.accounts.is_empty() && self.device.device_key_sha256.is_none() {
            return Err(platform_storage_invariant(
                "Profile admission has no Device key expectation",
            ));
        }
        Ok(())
    }
}

// Optional means absent. An explicitly null lifecycle or phase payload is malformed evidence.
pub(super) fn deserialize_present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

#[cfg(test)]
mod tests {
    use super::SessionDisposition;

    #[test]
    fn session_disposition_has_closed_camel_case_fields() {
        let valid = r#"{"type":"complete","sourceSessionInstance":null}"#;
        let session: SessionDisposition = serde_json::from_str(valid).unwrap();
        assert_eq!(serde_json::to_string(&session).unwrap(), valid);
        for malformed in [
            r#"{"type":"complete","source_session_instance":null}"#,
            r#"{"type":"complete"}"#,
            r#"{"type":"complete","sourceSessionInstance":null,"source_session_instance":null}"#,
            r#"{"type":"absentAtCapture","sourceSessionInstance":null}"#,
        ] {
            assert!(serde_json::from_str::<SessionDisposition>(malformed).is_err());
        }
    }
}
