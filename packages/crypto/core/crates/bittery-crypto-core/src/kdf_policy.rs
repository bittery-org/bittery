//! Canonical KDF profile policy shared with TypeScript.

use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

use crate::error::CryptoError;

const POLICY_JSON: &str = include_str!("../../../../kdf-policy.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KdfPolicy {
    schema_version: u32,
    algorithm: String,
    minimum_iterations: u32,
    default_iterations: u32,
    maximum_iterations: u32,
}

static POLICY: LazyLock<KdfPolicy> = LazyLock::new(|| {
    serde_json::from_str(POLICY_JSON).expect("packages/crypto/kdf-policy.json must be valid")
});

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KdfProfile {
    pub schema_version: u32,
    pub algorithm: String,
    pub iterations: u32,
}

pub fn current_kdf_profile() -> KdfProfile {
    KdfProfile {
        schema_version: POLICY.schema_version,
        algorithm: POLICY.algorithm.clone(),
        iterations: POLICY.default_iterations,
    }
}

pub fn minimum_iterations() -> u32 {
    POLICY.minimum_iterations
}

pub fn maximum_iterations() -> u32 {
    POLICY.maximum_iterations
}

pub fn validate_kdf_profile(
    profile: &KdfProfile,
    pinned_profile: Option<&KdfProfile>,
) -> Result<(), CryptoError> {
    validate_baseline(profile)?;
    if let Some(pinned) = pinned_profile {
        validate_baseline(pinned)?;
        if profile.schema_version != pinned.schema_version {
            return Err(CryptoError::InvalidInput(
                "KDF schema version changed from pinned value".to_string(),
            ));
        }
        if profile.algorithm != pinned.algorithm {
            return Err(CryptoError::InvalidInput(
                "KDF algorithm changed from pinned value".to_string(),
            ));
        }
        if profile.iterations < pinned.iterations {
            return Err(CryptoError::InvalidInput(
                "KDF iterations downgraded below pinned value".to_string(),
            ));
        }
    }
    Ok(())
}

pub fn is_current_kdf_profile(profile: &KdfProfile) -> bool {
    validate_baseline(profile).is_ok() && profile == &current_kdf_profile()
}

fn validate_baseline(profile: &KdfProfile) -> Result<(), CryptoError> {
    if profile.schema_version != POLICY.schema_version {
        return Err(CryptoError::InvalidInput(format!(
            "Unsupported KDF schema version: {}",
            profile.schema_version
        )));
    }
    if profile.algorithm != POLICY.algorithm {
        return Err(CryptoError::InvalidInput(format!(
            "Unsupported KDF algorithm: {}",
            profile.algorithm
        )));
    }
    if !(POLICY.minimum_iterations..=POLICY.maximum_iterations).contains(&profile.iterations) {
        return Err(CryptoError::InvalidInput(format!(
            "KDF iterations outside supported range: {}",
            profile.iterations
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(iterations: u32) -> KdfProfile {
        KdfProfile {
            schema_version: 1,
            algorithm: "pbkdf2-sha256".to_string(),
            iterations,
        }
    }

    #[test]
    fn canonical_policy_is_embedded() {
        assert_eq!(current_kdf_profile(), profile(600_000));
        assert!(is_current_kdf_profile(&profile(600_000)));
    }

    #[test]
    fn accepts_policy_bounds() {
        assert!(validate_kdf_profile(&profile(600_000), None).is_ok());
        assert!(validate_kdf_profile(&profile(1_200_000), None).is_ok());
    }

    #[test]
    fn rejects_out_of_range_counts() {
        for iterations in [0, 310_000, 599_999, 1_200_001, u32::MAX] {
            assert!(validate_kdf_profile(&profile(iterations), None).is_err());
        }
    }

    #[test]
    fn rejects_noncanonical_algorithms() {
        for algorithm in [
            "PBKDF2-SHA256",
            "pbkdf2-sha256 ",
            " pbkdf2-sha256",
            "pbkdf2_sha256",
            "sha256",
            "",
        ] {
            let mut candidate = profile(600_000);
            candidate.algorithm = algorithm.to_string();
            assert!(validate_kdf_profile(&candidate, None).is_err());
        }
    }

    #[test]
    fn rejects_downgrade_from_pin() {
        assert!(validate_kdf_profile(&profile(600_000), Some(&profile(1_200_000))).is_err());
    }
}
