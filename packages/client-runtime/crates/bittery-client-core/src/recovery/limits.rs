//! Typed recovery resource refusals cannot be mistaken for salvageable storage corruption.
use crate::{RecoveryBound, RuntimeError, RuntimeErrorCode};

pub(crate) fn exceeded(bound: RecoveryBound) -> RuntimeError {
    RuntimeError {
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
