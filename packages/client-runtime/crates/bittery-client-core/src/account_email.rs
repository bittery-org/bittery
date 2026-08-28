use crate::{RuntimeError, RuntimeErrorCode};

/// A canonical Account email accepted by the authenticated deletion contract.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NormalizedAccountEmail(String);

impl NormalizedAccountEmail {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_string(self) -> String {
        self.0
    }
}

/// Applies the shared cryptographic identity normalization and deletion wire bound.
pub fn normalize_account_email(input: &str) -> Result<NormalizedAccountEmail, RuntimeError> {
    let normalized = bittery_crypto_core::normalize_email(input);
    if normalized.is_empty() || normalized.len() > 254 {
        return Err(RuntimeError::new(
            RuntimeErrorCode::InvariantViolation,
            "Account deletion confirmation email is invalid",
        ));
    }
    Ok(NormalizedAccountEmail(normalized))
}
