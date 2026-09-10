use super::{
    archive::{DecodedRecord, EntryHeader},
    artifacts::{ArtifactInventory, ArtifactSelection},
    report::{Findings, ReadPhase, RecoveryFinding},
    transfer::{invalid, PhysicalReader, RecoveryPort},
};
use crate::replica::{
    persistence_contract::ReplicaHead,
    recovery::{CoverageProof, RecoveryCoverage},
};
use crate::{AccountId, RuntimeError, RuntimeErrorCode};

pub(crate) struct Snapshot {
    pub head_json: Option<String>,
    pub proof: Option<CoverageProof>,
    pub artifacts: ArtifactInventory,
    pub selection: Option<ArtifactSelection>,
    pub complete: bool,
    pub read_complete: bool,
    pub record_count: usize,
    pub failure: Option<RuntimeErrorCode>,
    pub(super) findings: Findings,
}
impl Snapshot {
    pub(crate) fn can_preserve_work(&self) -> bool {
        self.read_complete && self.proof.is_some() && self.selection.is_some()
    }
    pub(crate) fn needs_rebuild(&self) -> bool {
        self.proof
            .as_ref()
            .is_some_and(|proof| !proof.authority_valid)
    }
}

pub(crate) struct SnapshotBuilder {
    account_id: AccountId,
    head_json: Option<String>,
    coverage: Option<RecoveryCoverage>,
    artifacts: ArtifactInventory,
    artifacts_valid: bool,
    accepted_valid: bool,
    artifact_phase: bool,
    record_count: usize,
    failure: Option<RuntimeErrorCode>,
    findings: Findings,
}
impl SnapshotBuilder {
    pub(crate) fn new(account_id: AccountId) -> Self {
        Self {
            artifacts: ArtifactInventory::new(account_id.as_str().into()),
            account_id,
            head_json: None,
            coverage: None,
            artifacts_valid: true,
            accepted_valid: true,
            artifact_phase: false,
            record_count: 0,
            failure: None,
            findings: Findings::default(),
        }
    }
    pub(crate) fn observe(&mut self, record: &DecodedRecord) -> Result<(), RuntimeError> {
        self.record_count += 1;
        let result = self.observe_inner(record);
        if let Err(error) = &result {
            self.failure = Some(error.code);
            self.findings.record_invalid(&record.header);
            if matches!(
                record.header,
                EntryHeader::ReplicaHead { .. } | EntryHeader::ReplicaRow { .. }
            ) {
                self.accepted_valid = false;
            }
        }
        result
    }
    fn observe_inner(&mut self, record: &DecodedRecord) -> Result<(), RuntimeError> {
        match &record.header {
            EntryHeader::ReplicaHead { account_id } => {
                if account_id != self.account_id.as_str() || self.record_count != 1 {
                    self.accepted_valid = false;
                    return Err(invalid());
                }
                if record.body.len() > 64 * 1024 {
                    return Err(super::limits::exceeded(crate::RecoveryBound::RecordBytes));
                }
                let json = std::str::from_utf8(&record.body).map_err(|_| invalid())?;
                self.head_json = Some(json.to_owned());
                let head: ReplicaHead = serde_json::from_str(json).map_err(|_| invalid())?;
                if head.account_id != self.account_id {
                    self.accepted_valid = false;
                    return Err(invalid());
                }
                self.coverage = Some(RecoveryCoverage::new(head)?);
            }
            EntryHeader::ReplicaRow {
                account_id,
                store,
                record_id,
            } => {
                if account_id != self.account_id.as_str() || self.artifact_phase {
                    self.accepted_valid = false;
                    return Err(invalid());
                }
                let json = std::str::from_utf8(&record.body).map_err(|_| invalid())?;
                let result = self
                    .coverage
                    .as_mut()
                    .ok_or_else(invalid)?
                    .push_row(*store, record_id, json);
                if result.is_err() {
                    self.accepted_valid = false;
                }
                result?;
            }
            EntryHeader::Manifest { .. } | EntryHeader::Report => {
                self.accepted_valid = false;
                return Err(invalid());
            }
            _ => {
                self.artifact_phase = true;
                let result = self.artifacts.observe(record);
                if result.is_err() {
                    self.artifacts_valid = false;
                }
                result?;
            }
        }
        Ok(())
    }
    pub(crate) fn finish(mut self, read_complete: bool) -> Snapshot {
        let proof = if self.accepted_valid {
            self.coverage
                .take()
                .and_then(|coverage| match coverage.finish() {
                    Ok(proof) => Some(proof),
                    Err(error) => {
                        self.failure = Some(error.code);
                        self.findings
                            .push(RecoveryFinding::InvalidAcceptedRelationships);
                        None
                    }
                })
        } else {
            None
        };
        if let Some(proof) = &proof {
            for row in &proof.rows {
                if !row.valid {
                    self.findings.record_invalid(&EntryHeader::ReplicaRow {
                        account_id: self.account_id.as_str().into(),
                        store: row.store,
                        record_id: row.record_id.clone(),
                    });
                }
            }
            if !proof.authority_valid && proof.rows.iter().all(|row| row.valid) {
                self.findings
                    .push(RecoveryFinding::InvalidAuthorityRelationships);
            }
            self.artifacts
                .append_findings(proof, read_complete, &mut self.findings);
        } else if self.head_json.is_none() && read_complete {
            self.findings.push(RecoveryFinding::MissingReplicaHead);
        }
        let selection = if self.artifacts_valid {
            proof
                .as_ref()
                .and_then(|proof| match self.artifacts.select(proof) {
                    Ok(selection) => Some(selection),
                    Err(error) => {
                        self.failure = Some(error.code);
                        None
                    }
                })
        } else {
            None
        };
        let complete = read_complete
            && proof.as_ref().is_some_and(|proof| proof.authority_valid)
            && selection.is_some();
        Snapshot {
            head_json: self.head_json,
            proof,
            artifacts: self.artifacts,
            selection,
            complete,
            read_complete,
            record_count: self.record_count,
            failure: self.failure,
            findings: self.findings,
        }
    }
}
pub(crate) async fn capture(
    port: &RecoveryPort,
    account_id: &AccountId,
) -> Result<Snapshot, RuntimeError> {
    let mut reader = PhysicalReader::new(port, account_id);
    let mut builder = SnapshotBuilder::new(account_id.clone());
    loop {
        match reader.next().await {
            Ok(Some(record)) => {
                if let Err(error) = builder.observe(&record) {
                    if error.code == RuntimeErrorCode::SizeRejected {
                        return Err(error);
                    }
                }
            }
            Ok(None) => return Ok(builder.finish(true)),
            Err(error)
                if matches!(
                    error.code,
                    RuntimeErrorCode::Cancelled | RuntimeErrorCode::SizeRejected
                ) =>
            {
                return Err(error)
            }
            Err(error) => {
                builder.failure = Some(error.code);
                builder.findings.push(RecoveryFinding::ReadFailure {
                    phase: ReadPhase::Capture,
                    code: error.code,
                });
                return Ok(builder.finish(false));
            }
        }
    }
}
