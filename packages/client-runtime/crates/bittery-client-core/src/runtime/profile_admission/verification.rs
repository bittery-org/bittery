use super::{invoke_source, source::Manifest};
use crate::{
    ProfileAdmissionRequest, ProfileAdmissionResponse, ProfileSourceReopenStep as ReopenStep,
    ProfileSourceSnapshot, ProfileSourceVerificationResult as Verification,
    ProfileSourceVerifyStep as Step, Runtime, RuntimeError, RuntimeErrorCode,
    SerializedProfileAdmissionExecutor, PROFILE_SOURCE_CURSOR_BYTES,
};

fn invalid() -> RuntimeError {
    super::startup_invariant("Profile source verification response is inconsistent")
}

async fn invoke(
    runtime: &Runtime,
    executor: &dyn SerializedProfileAdmissionExecutor,
    request: ProfileAdmissionRequest,
) -> Result<Verification, RuntimeError> {
    runtime.ensure_not_closed()?;
    let response = invoke_source(executor, request).await?;
    runtime.ensure_not_closed()?;
    match response {
        ProfileAdmissionResponse::SourceSnapshotVerification {
            result: Verification::Changed {},
        } => Err(super::startup_invariant(
            "Legacy profile source changed during verification",
        )),
        ProfileAdmissionResponse::SourceSnapshotVerification {
            result: Verification::Unavailable {},
        } => Err(RuntimeError::new(
            RuntimeErrorCode::StorageUnavailable,
            "Legacy profile source verification is unavailable",
        )),
        ProfileAdmissionResponse::SourceSnapshotVerification { result } => Ok(result),
        _ => Err(invalid()),
    }
}

fn cursor(value: String) -> Result<String, RuntimeError> {
    if value.is_empty() || value.len() > PROFILE_SOURCE_CURSOR_BYTES {
        Err(invalid())
    } else {
        Ok(value)
    }
}

/// A new call is a fresh physical pass. Lost replies retain the Runtime's existing snapshot
/// cleanup duty; admission cannot reach destination writes with a partial or ambiguous proof.
pub(super) async fn verify(
    runtime: &Runtime,
    executor: &dyn SerializedProfileAdmissionExecutor,
    snapshot: &ProfileSourceSnapshot,
    manifest: &Manifest,
) -> Result<(), RuntimeError> {
    match prove(runtime, executor, manifest, Some(snapshot)).await? {
        Verification::Unchanged { snapshot_handle }
            if snapshot_handle == snapshot.snapshot_handle =>
        {
            Ok(())
        }
        _ => Err(invalid()),
    }
}

pub(super) async fn reopen(
    runtime: &Runtime,
    executor: &dyn SerializedProfileAdmissionExecutor,
    manifest: &Manifest,
) -> Result<ProfileSourceSnapshot, RuntimeError> {
    let Verification::Reopened { snapshot } = prove(runtime, executor, manifest, None).await?
    else {
        return Err(invalid());
    };
    super::validate_source_snapshot(&snapshot, manifest.header.format)?;
    if snapshot.profile_identity != manifest.header.profile_identity
        || snapshot.capture_id == manifest.header.recorded_capture_id
    {
        return Err(invalid());
    }
    Ok(snapshot)
}

async fn prove(
    runtime: &Runtime,
    executor: &dyn SerializedProfileAdmissionExecutor,
    manifest: &Manifest,
    snapshot: Option<&ProfileSourceSnapshot>,
) -> Result<Verification, RuntimeError> {
    let verification_attempt_id = bittery_crypto_core::generate_uuid();
    let request = match snapshot {
        Some(snapshot) => ProfileAdmissionRequest::VerifySourceSnapshot {
            step: Step::Start {
                verification_attempt_id,
                snapshot_handle: snapshot.snapshot_handle.clone(),
                header: manifest.header.clone(),
            },
        },
        None => ProfileAdmissionRequest::ReopenSourceSnapshot {
            step: ReopenStep::Start {
                verification_attempt_id,
                header: manifest.header.clone(),
            },
        },
    };
    let started = invoke(runtime, executor, request).await?;
    let Verification::Started {
        verification_cursor,
        next_index: 0,
    } = started
    else {
        return Err(invalid());
    };
    let mut verification_cursor = cursor(verification_cursor)?;
    for (index, expected_entry) in manifest.entries.iter().enumerate() {
        let index = u64::try_from(index).map_err(|_| invalid())?;
        let matched = invoke(
            runtime,
            executor,
            if snapshot.is_some() {
                ProfileAdmissionRequest::VerifySourceSnapshot {
                    step: Step::Entry {
                        verification_cursor,
                        index,
                        expected_entry: expected_entry.clone(),
                    },
                }
            } else {
                ProfileAdmissionRequest::ReopenSourceSnapshot {
                    step: ReopenStep::Entry {
                        verification_cursor,
                        index,
                        expected_entry: expected_entry.clone(),
                    },
                }
            },
        )
        .await?;
        let Verification::Matched {
            verification_cursor: next_cursor,
            next_index,
        } = matched
        else {
            return Err(invalid());
        };
        if index.checked_add(1) != Some(next_index) {
            return Err(invalid());
        }
        verification_cursor = cursor(next_cursor)?;
    }
    invoke(
        runtime,
        executor,
        if snapshot.is_some() {
            ProfileAdmissionRequest::VerifySourceSnapshot {
                step: Step::Finish {
                    verification_cursor,
                },
            }
        } else {
            ProfileAdmissionRequest::ReopenSourceSnapshot {
                step: ReopenStep::Finish {
                    verification_cursor,
                },
            }
        },
    )
    .await
}
