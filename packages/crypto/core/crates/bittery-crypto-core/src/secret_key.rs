//! Secret Key Generation
//!
//! Generates a 1Password-style Secret Key in format: A3-XXXXXX-XXXXXX-XXXXX-XXXXX-XXXXX

use rand::RngCore;

/// Base32 charset without confusing characters (0, 1, 8, 9, O, I, L)
const CHARSET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// Version prefix for secret keys
const VERSION_PREFIX: &str = "A3";

/// Generate a cryptographically secure Secret Key
///
/// Format: A3-XXXXXX-XXXXXX-XXXXX-XXXXX-XXXXX (34 characters including dashes)
///
/// # Returns
/// A new secret key string
pub fn generate_secret_key() -> String {
    let segments = [
        VERSION_PREFIX.to_string(),
        generate_segment(6),
        generate_segment(6),
        generate_segment(5),
        generate_segment(5),
        generate_segment(5),
    ];
    segments.join("-")
}

/// Generate a random segment of specified length
fn generate_segment(length: usize) -> String {
    let mut rng = rand::thread_rng();
    let mut bytes = vec![0u8; length];
    rng.fill_bytes(&mut bytes);

    bytes
        .iter()
        .map(|&byte| CHARSET[(byte as usize) % CHARSET.len()] as char)
        .collect()
}

/// Validate Secret Key format
///
/// # Arguments
/// * `secret_key` - The secret key to validate
///
/// # Returns
/// `true` if the format is valid, `false` otherwise
pub fn validate_secret_key(secret_key: &str) -> bool {
    // Pattern: A3-XXXXXX-XXXXXX-XXXXX-XXXXX-XXXXX
    // where X is [A-Z2-7]
    let parts: Vec<&str> = secret_key.split('-').collect();

    if parts.len() != 6 {
        return false;
    }

    // Check version prefix
    if parts[0] != VERSION_PREFIX {
        return false;
    }

    // Check segment lengths: 6, 6, 5, 5, 5
    let expected_lengths = [6, 6, 5, 5, 5];
    for (i, &expected_len) in expected_lengths.iter().enumerate() {
        let segment = parts[i + 1];
        if segment.len() != expected_len {
            return false;
        }
        // Check all characters are valid base32
        if !segment.chars().all(|c| CHARSET.contains(&(c as u8))) {
            return false;
        }
    }

    true
}

/// Get Secret Key hint (first segment for UX display)
///
/// # Arguments
/// * `secret_key` - The full secret key
///
/// # Returns
/// The hint portion (e.g., "A3-ABCDEF")
pub fn get_secret_key_hint(secret_key: &str) -> String {
    let parts: Vec<&str> = secret_key.split('-').collect();
    if parts.len() >= 2 {
        format!("{}-{}", parts[0], parts[1])
    } else {
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_secret_key_format() {
        let key = generate_secret_key();

        // Check format: A3-XXXXXX-XXXXXX-XXXXX-XXXXX-XXXXX
        assert!(key.starts_with("A3-"));

        let parts: Vec<&str> = key.split('-').collect();
        assert_eq!(parts.len(), 6);
        assert_eq!(parts[0], "A3");
        assert_eq!(parts[1].len(), 6);
        assert_eq!(parts[2].len(), 6);
        assert_eq!(parts[3].len(), 5);
        assert_eq!(parts[4].len(), 5);
        assert_eq!(parts[5].len(), 5);
    }

    #[test]
    fn test_generate_secret_key_unique() {
        let key1 = generate_secret_key();
        let key2 = generate_secret_key();

        assert_ne!(key1, key2);
    }

    #[test]
    fn test_generate_secret_key_valid_charset() {
        let key = generate_secret_key();

        // Remove dashes and version prefix
        let chars: String = key.split('-').skip(1).collect::<Vec<_>>().join("");

        for c in chars.chars() {
            assert!(
                CHARSET.contains(&(c as u8)),
                "Invalid character '{}' in secret key",
                c
            );
        }
    }

    #[test]
    fn test_validate_secret_key_valid() {
        let key = generate_secret_key();
        assert!(validate_secret_key(&key));
    }

    #[test]
    fn test_validate_secret_key_manual() {
        assert!(validate_secret_key("A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2"));
        assert!(validate_secret_key("A3-234567-ABCDEF-GHIJK-LMNOP-QRSTU"));
    }

    #[test]
    fn test_validate_secret_key_invalid() {
        // Wrong prefix
        assert!(!validate_secret_key("B3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2"));

        // Wrong segment length
        assert!(!validate_secret_key("A3-ABCDE-GHIJKL-MNOPQ-RSTUV-WXYZ2"));

        // Invalid characters (0, 1, 8, 9 not in charset)
        assert!(!validate_secret_key("A3-ABC019-GHIJKL-MNOPQ-RSTUV-WXYZ2"));

        // Too few segments
        assert!(!validate_secret_key("A3-ABCDEF-GHIJKL"));

        // Empty
        assert!(!validate_secret_key(""));
    }

    #[test]
    fn test_get_secret_key_hint() {
        let key = "A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2";
        assert_eq!(get_secret_key_hint(key), "A3-ABCDEF");
    }

    #[test]
    fn test_get_secret_key_hint_empty() {
        assert_eq!(get_secret_key_hint("invalid"), "");
    }
}
