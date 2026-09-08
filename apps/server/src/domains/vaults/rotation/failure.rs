//! Typed Domain proof versus a transaction that did not reach a decision.
use super::plans::FinalizeError;
use crate::{
    db::enums::{OperationRejectionCode, VaultKeyRotationStaleReason},
    error::AppError,
};

#[derive(Debug)]
pub(crate) enum RotationFailure {
    Rejected {
        code: OperationRejectionCode,
        stale: Option<(String, VaultKeyRotationStaleReason)>,
    },
    Infrastructure(AppError),
}
impl RotationFailure {
    pub(crate) fn rejected(code: OperationRejectionCode) -> Self {
        Self::Rejected { code, stale: None }
    }
    pub(crate) fn finalize(plan_id: &str, error: FinalizeError) -> Self {
        match error {
            FinalizeError::Stale(reason) => Self::Rejected {
                code: OperationRejectionCode::RotationPlanStale,
                stale: Some((plan_id.to_owned(), reason)),
            },
            FinalizeError::InvalidState => {
                Self::rejected(OperationRejectionCode::RotationPlanUnavailable)
            }
            FinalizeError::Incomplete => {
                Self::rejected(OperationRejectionCode::RotationPlanIncomplete)
            }
            FinalizeError::RetryableConflict => AppError::retryable_conflict(
                "Concurrent update interrupted Rotation; retry the request",
            )
            .into(),
            FinalizeError::Database(message) => {
                tracing::error!(%message, "Rotation transaction failed");
                AppError::internal("Rotation transaction failed").into()
            }
        }
    }
}
impl From<AppError> for RotationFailure {
    fn from(value: AppError) -> Self {
        Self::Infrastructure(value)
    }
}

// Old mechanism/policy tests exercise the same transaction functions without constructing an HTTP
// Operation. Their adapter preserves the legacy AppError assertions, never a production writer.
#[cfg(test)]
impl From<RotationFailure> for AppError {
    fn from(value: RotationFailure) -> Self {
        match value {
            RotationFailure::Infrastructure(error) => error,
            RotationFailure::Rejected {
                stale: Some((_, reason)),
                ..
            } => AppError::rotation_stale(reason),
            RotationFailure::Rejected { code, .. } => match code {
                OperationRejectionCode::SelfRemovalForbidden
                | OperationRejectionCode::SharedVaultRequired
                | OperationRejectionCode::PersonalTeamDepartureForbidden
                | OperationRejectionCode::TeamOwnerLeaveForbidden
                | OperationRejectionCode::RotationPlanMismatch
                | OperationRejectionCode::RotationPlanSetMismatch => {
                    AppError::bad_request(code.as_str())
                }
                OperationRejectionCode::VaultMemberNotFound
                | OperationRejectionCode::TeamMemberNotFound => AppError::not_found(code.as_str()),
                OperationRejectionCode::VaultMembershipChanged
                | OperationRejectionCode::TeamMembershipChanged
                | OperationRejectionCode::RotationPlanUnavailable
                | OperationRejectionCode::RotationPlanIncomplete => {
                    AppError::conflict(code.as_str())
                }
                _ => AppError::forbidden(code.as_str()),
            },
        }
    }
}
