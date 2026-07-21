//! Canonicalization for identities used by cryptographic protocols.

use unicode_normalization::UnicodeNormalization;

/// Normalize an email before using it as an account identifier or KDF salt.
///
/// Lowercasing happens before the final NFKC pass so the returned value itself
/// is normalized even when Unicode case mapping expands a character.
pub fn normalize_email(email: &str) -> String {
    email.trim().to_lowercase().nfkc().collect()
}

/// Normalize an SRP username without changing its case or surrounding bytes.
pub(crate) fn normalize_srp_username(username: &str) -> String {
    username.nfkc().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_email_trims_lowercases_and_applies_nfkc() {
        assert_eq!(
            normalize_email("  MU\u{0308}LLER@EXAMPLE.COM  "),
            "müller@example.com"
        );
        assert_eq!(
            normalize_email("ＭＵ̈ＬＬＥＲ＠ＥＸＡＭＰＬＥ．ＣＯＭ"),
            "müller@example.com"
        );
    }
}
