//! Typed recovery resource refusals cannot be mistaken for salvageable storage corruption.
use crate::{RecoveryBound, RuntimeError, RuntimeErrorCode};

pub use bittery_crypto_core::replica_recovery::RECOVERY_CHUNK_BYTES;
pub(crate) const MAX_RECORD_BYTES: usize = 64 * 1024 * 1024;
pub const RECOVERY_CONTROL_BYTES: usize = MAX_RECORD_BYTES + 64 * 1024;
/// Existing Web source/spool admission bound, including authenticated envelope overhead. Core's
/// cryptographic reader independently enforces the plaintext archive limit and frame validity.
pub const RECOVERY_MAX_FILE_BYTES: u64 =
    bittery_crypto_core::replica_recovery::RECOVERY_MAX_PLAINTEXT_BYTES + 1024 * 1024;

pub(crate) fn exceeded(bound: RecoveryBound) -> RuntimeError {
    RuntimeError {
        team_page_problem: None,
        code: RuntimeErrorCode::SizeRejected,
        message: "Recovery exceeds its implementation resource bound".into(),
        recovery_bound: Some(bound),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_bound_is_typed_and_absent_from_unrelated_errors() {
        let error = exceeded(RecoveryBound::RecordBytes);
        let json = serde_json::to_value(&error).unwrap();
        assert_eq!(json["code"], "SIZE_REJECTED");
        assert_eq!(json["recoveryBound"], "recordBytes");
        assert_eq!(serde_json::from_value::<RuntimeError>(json).unwrap(), error);
        let ordinary = RuntimeError::new(RuntimeErrorCode::SizeRejected, "Other size refusal");
        assert_eq!(
            serde_json::to_value(ordinary).unwrap(),
            serde_json::json!({
                "code": "SIZE_REJECTED", "message": "Other size refusal"
            })
        );
        assert!(serde_json::from_value::<RuntimeError>(serde_json::json!({
            "code": "SIZE_REJECTED", "message": "ignored", "recoveryBound": "unknown"
        }))
        .is_err());
    }
}
