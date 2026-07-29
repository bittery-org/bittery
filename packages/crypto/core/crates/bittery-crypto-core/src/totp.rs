//! TOTP (Time-Based One-Time Password) Implementation
//! Based on RFC 6238 and RFC 4226 (HOTP)

use hmac::{Hmac, KeyInit, Mac};
use sha1::Sha1;
use sha2::{Sha256, Sha512};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::CryptoError;

// Base32 alphabet (RFC 4648)
const BASE32_ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// Result of generating a TOTP code
pub struct TotpResult {
    /// The generated TOTP code (zero-padded)
    pub code: String,
    /// Seconds remaining until the code expires
    pub remaining_seconds: u64,
    /// Total period in seconds
    pub period: u64,
    /// Progress percentage (0-100) of time elapsed in current period
    pub progress: f64,
}

fn base32_decode(input: &str) -> Result<Vec<u8>, CryptoError> {
    let sanitized: String = input
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '=')
        .map(|c| c.to_ascii_uppercase())
        .collect();

    if sanitized.is_empty() {
        return Ok(vec![]);
    }

    let output_len = (sanitized.len() * 5) / 8;
    let mut output = vec![0u8; output_len];
    let mut buffer: u32 = 0;
    let mut bits_left: u32 = 0;
    let mut output_index = 0;

    for c in sanitized.chars() {
        let value = BASE32_ALPHABET
            .iter()
            .position(|&b| b == c as u8)
            .ok_or_else(|| CryptoError::InvalidInput(format!("Invalid base32 character: {}", c)))?;

        buffer = (buffer << 5) | (value as u32);
        bits_left += 5;

        if bits_left >= 8 {
            bits_left -= 8;
            output[output_index] = ((buffer >> bits_left) & 0xFF) as u8;
            output_index += 1;
        }
    }

    Ok(output)
}

fn hotp(secret: &[u8], counter: u64, algorithm: &str, digits: u32) -> Result<String, CryptoError> {
    let counter_bytes = counter.to_be_bytes();

    let hash: Vec<u8> = match algorithm.to_uppercase().as_str() {
        "SHA256" => {
            type HmacSha256 = Hmac<Sha256>;
            let mut mac = HmacSha256::new_from_slice(secret)
                .map_err(|e| CryptoError::InvalidInput(e.to_string()))?;
            mac.update(&counter_bytes);
            mac.finalize().into_bytes().to_vec()
        }
        "SHA512" => {
            type HmacSha512 = Hmac<Sha512>;
            let mut mac = HmacSha512::new_from_slice(secret)
                .map_err(|e| CryptoError::InvalidInput(e.to_string()))?;
            mac.update(&counter_bytes);
            mac.finalize().into_bytes().to_vec()
        }
        _ => {
            // Default: SHA1
            type HmacSha1 = Hmac<Sha1>;
            let mut mac = HmacSha1::new_from_slice(secret)
                .map_err(|e| CryptoError::InvalidInput(e.to_string()))?;
            mac.update(&counter_bytes);
            mac.finalize().into_bytes().to_vec()
        }
    };

    // Dynamic truncation (RFC 4226 §5.3)
    let offset = (hash[hash.len() - 1] & 0x0f) as usize;
    let binary = ((hash[offset] as u32 & 0x7f) << 24)
        | ((hash[offset + 1] as u32 & 0xff) << 16)
        | ((hash[offset + 2] as u32 & 0xff) << 8)
        | (hash[offset + 3] as u32 & 0xff);

    let modulus = 10u32.pow(digits);
    let otp = binary % modulus;

    Ok(format!("{:0>width$}", otp, width = digits as usize))
}

/// Generate a TOTP code for the current time (RFC 6238)
pub fn generate_totp(
    secret: &str,
    algorithm: &str,
    digits: u32,
    period: u64,
) -> Result<TotpResult, CryptoError> {
    let secret_bytes = base32_decode(secret)?;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| CryptoError::InvalidInput(format!("System time error: {}", e)))?
        .as_secs();

    let counter = now / period;
    let code = hotp(&secret_bytes, counter, algorithm, digits)?;

    let elapsed = now % period;
    let remaining_seconds = period - elapsed;
    let progress = (elapsed as f64 / period as f64) * 100.0;

    Ok(TotpResult {
        code,
        remaining_seconds,
        period,
        progress,
    })
}

/// Generate a TOTP code for a specific timestamp (useful for testing)
pub fn generate_totp_at(
    secret: &str,
    algorithm: &str,
    digits: u32,
    period: u64,
    timestamp: u64,
) -> Result<String, CryptoError> {
    let secret_bytes = base32_decode(secret)?;
    let counter = timestamp / period;
    hotp(&secret_bytes, counter, algorithm, digits)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 6238 Appendix B seed, base32-encoded: ASCII "12345678901234567890".
    const SEED_SHA1: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    /// RFC 6238 Appendix B seed32: ASCII "12345678901234567890123456789012".
    const SEED_SHA256: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA====";
    /// RFC 6238 Appendix B seed64: ASCII "1234...1234" (64 bytes).
    const SEED_SHA512: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA=";

    /// Known-answer tests straight from RFC 6238 Appendix B (T0 = 0, X = 30,
    /// 8 digits). These pin the HMAC output across `hmac`/`sha1`/`sha2` major
    /// version bumps: a change here would silently invalidate every stored TOTP
    /// secret.
    #[test]
    fn totp_matches_rfc6238_test_vectors() {
        let cases: &[(u64, &str, &str, &str)] = &[
            (59, "94287082", "46119246", "90693936"),
            (1_111_111_109, "07081804", "68084774", "25091201"),
            (1_111_111_111, "14050471", "67062674", "99943326"),
            (1_234_567_890, "89005924", "91819424", "93441116"),
            (2_000_000_000, "69279037", "90698825", "38618901"),
            (20_000_000_000, "65353130", "77737706", "47863826"),
        ];

        for &(timestamp, sha1, sha256, sha512) in cases {
            assert_eq!(
                generate_totp_at(SEED_SHA1, "SHA1", 8, 30, timestamp).unwrap(),
                sha1,
                "SHA1 vector at T={timestamp}"
            );
            assert_eq!(
                generate_totp_at(SEED_SHA256, "SHA256", 8, 30, timestamp).unwrap(),
                sha256,
                "SHA256 vector at T={timestamp}"
            );
            assert_eq!(
                generate_totp_at(SEED_SHA512, "SHA512", 8, 30, timestamp).unwrap(),
                sha512,
                "SHA512 vector at T={timestamp}"
            );
        }
    }

    #[test]
    fn totp_defaults_to_sha1_for_unknown_algorithms() {
        let expected = generate_totp_at(SEED_SHA1, "SHA1", 6, 30, 59).unwrap();
        assert_eq!(
            generate_totp_at(SEED_SHA1, "not-a-hash", 6, 30, 59).unwrap(),
            expected
        );
    }

    #[test]
    fn totp_algorithm_name_is_case_insensitive() {
        assert_eq!(
            generate_totp_at(SEED_SHA256, "sha256", 8, 30, 59).unwrap(),
            "46119246"
        );
    }

    #[test]
    fn totp_truncates_to_the_requested_number_of_digits() {
        let code = generate_totp_at(SEED_SHA1, "SHA1", 6, 30, 59).unwrap();
        assert_eq!(code.len(), 6);
        assert_eq!(code, "287082");
    }

    #[test]
    fn base32_decode_rejects_invalid_characters() {
        assert!(generate_totp_at("ABC!DEF", "SHA1", 6, 30, 59).is_err());
    }

    #[test]
    fn generate_totp_reports_period_progress() {
        let result = generate_totp(SEED_SHA1, "SHA1", 6, 30).unwrap();
        assert_eq!(result.period, 30);
        assert_eq!(result.code.len(), 6);
        assert!(result.remaining_seconds > 0 && result.remaining_seconds <= 30);
        assert!(result.progress >= 0.0 && result.progress < 100.0);
    }
}
