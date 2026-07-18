//! KDF policy validation and pinning checks.
//!
//! Used to enforce server-provided login KDF parameters against local policy
//! and previously pinned values.

use serde::{Deserialize, Serialize};

use crate::error::CryptoError;

pub const KDF_SCHEMA_VERSION: u32 = 1;
pub const KDF_ALGORITHM_PBKDF2_SHA256: &str = "pbkdf2-sha256";
pub const MIN_PBKDF2_ITERATIONS: u32 = 310_000;
pub const MIN_SALT_BYTES: usize = 16;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KdfParams {
    pub schema_version: u32,
    pub algorithm: String,
    pub iterations: u32,
    pub salt: String,
}

pub fn default_login_kdf_params(salt: &str) -> KdfParams {
    KdfParams {
        schema_version: KDF_SCHEMA_VERSION,
        algorithm: KDF_ALGORITHM_PBKDF2_SHA256.to_string(),
        // Serve the current client default (not the policy floor) so unknown-email
        // login probes are indistinguishable from real accounts created today.
        iterations: crate::key_derivation::PBKDF2_ITERATIONS,
        salt: salt.to_string(),
    }
}

pub fn validate_server_kdf_params(
    server_params: &KdfParams,
    pinned_params: Option<&KdfParams>,
) -> Result<(), CryptoError> {
    validate_policy_baseline(server_params)?;

    if let Some(pinned) = pinned_params {
        validate_policy_baseline(pinned)?;

        if server_params.schema_version != pinned.schema_version {
            return Err(CryptoError::InvalidInput(
                "KDF schema version changed from pinned value".to_string(),
            ));
        }

        if !server_params.algorithm.eq_ignore_ascii_case(&pinned.algorithm) {
            return Err(CryptoError::InvalidInput(
                "KDF algorithm changed from pinned value".to_string(),
            ));
        }

        if server_params.iterations < pinned.iterations {
            return Err(CryptoError::InvalidInput(
                "KDF iterations downgraded below pinned value".to_string(),
            ));
        }

        if server_params.salt != pinned.salt {
            return Err(CryptoError::InvalidInput(
                "KDF salt changed from pinned value".to_string(),
            ));
        }
    }

    Ok(())
}

fn validate_policy_baseline(params: &KdfParams) -> Result<(), CryptoError> {
    if params.schema_version != KDF_SCHEMA_VERSION {
        return Err(CryptoError::InvalidInput(format!(
            "Unsupported KDF schema version: {}",
            params.schema_version
        )));
    }

    if !params
        .algorithm
        .eq_ignore_ascii_case(KDF_ALGORITHM_PBKDF2_SHA256)
    {
        return Err(CryptoError::InvalidInput(format!(
            "Unsupported KDF algorithm: {}",
            params.algorithm
        )));
    }

    if params.iterations < MIN_PBKDF2_ITERATIONS {
        return Err(CryptoError::InvalidInput(format!(
            "KDF iterations below minimum: {}",
            params.iterations
        )));
    }

    let decoded_salt = hex::decode(&params.salt)
        .map_err(|_| CryptoError::InvalidInput("KDF salt must be valid hex".to_string()))?;
    if decoded_salt.len() < MIN_SALT_BYTES {
        return Err(CryptoError::InvalidInput(format!(
            "KDF salt too short: {} bytes",
            decoded_salt.len()
        )));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_salt() -> String {
        "00112233445566778899AABBCCDDEEFF00112233445566778899AABBCCDDEEFF".to_string()
    }

    fn sample_params() -> KdfParams {
        KdfParams {
            schema_version: KDF_SCHEMA_VERSION,
            algorithm: KDF_ALGORITHM_PBKDF2_SHA256.to_string(),
            iterations: MIN_PBKDF2_ITERATIONS,
            salt: sample_salt(),
        }
    }

    #[test]
    fn accepts_valid_params_without_pin() {
        let params = sample_params();
        assert!(validate_server_kdf_params(&params, None).is_ok());
    }

    #[test]
    fn rejects_iteration_downgrade_from_pin() {
        let mut server = sample_params();
        let pinned = sample_params();
        server.iterations = MIN_PBKDF2_ITERATIONS - 1;
        assert!(validate_server_kdf_params(&server, Some(&pinned)).is_err());
    }

    #[test]
    fn rejects_salt_change_from_pin() {
        let mut server = sample_params();
        let pinned = sample_params();
        server.salt =
            "AA112233445566778899AABBCCDDEEFF00112233445566778899AABBCCDDEEFF".to_string();
        assert!(validate_server_kdf_params(&server, Some(&pinned)).is_err());
    }

    #[test]
    fn rejects_algorithm_change_from_pin() {
        let mut server = sample_params();
        let pinned = sample_params();
        server.algorithm = "pbkdf2-sha1".to_string();
        assert!(validate_server_kdf_params(&server, Some(&pinned)).is_err());
    }
}
