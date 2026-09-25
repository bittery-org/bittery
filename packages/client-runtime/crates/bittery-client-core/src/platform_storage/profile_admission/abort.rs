use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AbortAccountField {
    Metadata,
    QuickUnlock,
    LocalSecurity,
    CurrentSession,
    LegacySessionEvidence,
    Replica,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    remote = "Self",
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum AbortCleanupTarget {
    DeviceKey {},
    LocalSecurity {},
    Account {
        #[serde(with = "crate::wire::decimal_u64")]
        index: u64,
        field: AbortAccountField,
    },
}
crate::wire::map_only_serde!(AbortCleanupTarget);

impl AdmissionProgress {
    pub(crate) fn abort_targets(&self) -> Vec<AbortCleanupTarget> {
        let mut targets = Vec::new();
        if matches!(self.device.original_key, OriginalDocument::Absent {})
            && self.device.device_key_sha256.is_some()
        {
            targets.push(AbortCleanupTarget::DeviceKey {});
        }
        if matches!(
            self.device.original_global_security,
            OriginalDocument::Absent {}
        ) {
            targets.push(AbortCleanupTarget::LocalSecurity {});
        }
        for (index, account) in self.accounts.iter().enumerate() {
            let index = index as u64;
            for field in [
                AbortAccountField::Metadata,
                AbortAccountField::QuickUnlock,
                AbortAccountField::LocalSecurity,
            ] {
                targets.push(AbortCleanupTarget::Account { index, field });
            }
            if account.expected.current_session_sha256.is_some() {
                targets.push(AbortCleanupTarget::Account {
                    index,
                    field: AbortAccountField::CurrentSession,
                });
            }
            if account.expected.legacy_session_evidence_sha256.is_some() {
                targets.push(AbortCleanupTarget::Account {
                    index,
                    field: AbortAccountField::LegacySessionEvidence,
                });
            }
            targets.push(AbortCleanupTarget::Account {
                index,
                field: AbortAccountField::Replica,
            });
        }
        targets
    }
    pub(super) fn validate_abort(
        &self,
        phase: ImportPhase,
        accounts: &[DeviceCatalogAccount],
    ) -> Result<(), RuntimeError> {
        match (phase, &self.abort_remaining) {
            (ImportPhase::Preparing | ImportPhase::Committed, None) => Ok(()),
            (ImportPhase::Aborted, Some(remaining))
                if remaining.is_empty() && accounts.is_empty() =>
            {
                Ok(())
            }
            (ImportPhase::Aborting, Some(remaining)) => {
                let targets = self.abort_targets();
                let mut previous = None;
                for target in remaining {
                    let position = targets
                        .iter()
                        .position(|expected| expected == target)
                        .ok_or_else(|| {
                            platform_storage_invariant(
                                "Abort target is outside admission ownership",
                            )
                        })?;
                    if previous.is_some_and(|previous| previous >= position) {
                        return Err(platform_storage_invariant(
                            "Abort targets are duplicated or unordered",
                        ));
                    }
                    previous = Some(position);
                }
                Ok(())
            }
            _ => Err(platform_storage_invariant(
                "Abort progress disagrees with admission phase",
            )),
        }
    }
}
impl ProfileAdmissionRecord {
    pub(crate) fn begin_abort(&mut self) -> Result<(), RuntimeError> {
        if self.phase() != Some(ImportPhase::Preparing) {
            return Err(platform_storage_invariant(
                "Only Preparing admission can begin Abort",
            ));
        }
        let progress = self
            .progress_mut()
            .ok_or_else(|| platform_storage_invariant("Abort lost its fixed progress"))?;
        progress.abort_remaining = Some(progress.abort_targets());
        self.advance(ImportPhase::Aborting)
    }
    pub(crate) fn record_abort_absent(
        &mut self,
        target: &AbortCleanupTarget,
    ) -> Result<bool, RuntimeError> {
        if self.phase() != Some(ImportPhase::Aborting) {
            return Err(platform_storage_invariant(
                "Abort cleanup requires Aborting",
            ));
        }
        let remaining = self
            .progress_mut()
            .and_then(|progress| progress.abort_remaining.as_mut())
            .ok_or_else(|| platform_storage_invariant("Abort lost its cleanup targets"))?;
        let Some(index) = remaining.iter().position(|entry| entry == target) else {
            return Ok(false);
        };
        remaining.remove(index);
        self.advance(ImportPhase::Aborting)?;
        Ok(true)
    }
    pub(crate) fn complete_abort(&mut self) -> Result<(), RuntimeError> {
        if self.phase() != Some(ImportPhase::Aborting)
            || self
                .progress()
                .and_then(|progress| progress.abort_remaining.as_ref())
                .is_none_or(|remaining| !remaining.is_empty())
        {
            return Err(platform_storage_invariant(
                "Abort destination cleanup is incomplete",
            ));
        }
        self.advance(ImportPhase::Aborted)
    }
}
