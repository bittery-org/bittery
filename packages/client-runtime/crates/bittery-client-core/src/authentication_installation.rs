use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use bittery_crypto_core::{decrypt, encrypt, EncryptedData};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use zeroize::Zeroizing;

use crate::{RuntimeError, RuntimeErrorCode};

const MASTER_UNLOCK_KEY_BYTES: usize = 32;
const NANOS_PER_MILLISECOND: i128 = 1_000_000;

/// The one clock capability Account installation needs.
pub(crate) trait Clock: Send + Sync {
    fn now_ms(&self) -> Result<u64, RuntimeError>;
}

pub(crate) struct SystemClock;

#[cfg(test)]
pub(crate) struct FixedClock(pub(crate) u64);

#[cfg(test)]
impl Clock for FixedClock {
    fn now_ms(&self) -> Result<u64, RuntimeError> {
        Ok(self.0)
    }
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
impl Clock for SystemClock {
    fn now_ms(&self) -> Result<u64, RuntimeError> {
        use std::time::{SystemTime, UNIX_EPOCH};

        let elapsed = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "System clock is before the Unix epoch",
            )
        })?;
        u64::try_from(elapsed.as_millis()).map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "System clock is outside the supported range",
            )
        })
    }
}

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
impl Clock for SystemClock {
    fn now_ms(&self) -> Result<u64, RuntimeError> {
        let milliseconds = js_sys::Date::now();
        if !milliseconds.is_finite() || milliseconds < 0.0 || milliseconds > u64::MAX as f64 {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "System clock is outside the supported range",
            ));
        }

        Ok(milliseconds as u64)
    }
}

/// Preserves the existing quick-unlock plaintext and encryption format.
pub(crate) fn wrap_master_unlock_key(
    master_unlock_key: &[u8; MASTER_UNLOCK_KEY_BYTES],
    device_key: &[u8; MASTER_UNLOCK_KEY_BYTES],
) -> Result<EncryptedData, RuntimeError> {
    let plaintext = Zeroizing::new(BASE64.encode(master_unlock_key));
    encrypt(&plaintext, device_key).map_err(|_| {
        RuntimeError::new(
            RuntimeErrorCode::InvariantViolation,
            "Master unlock key could not be wrapped",
        )
    })
}

/// Opens only the exact standard-Base64, 32-byte quick-unlock form.
pub(crate) fn unwrap_master_unlock_key(
    wrapped: &EncryptedData,
    device_key: &[u8; MASTER_UNLOCK_KEY_BYTES],
) -> Result<Zeroizing<[u8; MASTER_UNLOCK_KEY_BYTES]>, RuntimeError> {
    let plaintext = Zeroizing::new(decrypt(wrapped, device_key).map_err(|_| {
        RuntimeError::new(
            RuntimeErrorCode::AuthenticationRequired,
            "Stored master unlock key is invalid",
        )
    })?);
    let decoded = Zeroizing::new(BASE64.decode(plaintext.as_bytes()).map_err(|_| {
        RuntimeError::new(
            RuntimeErrorCode::AuthenticationRequired,
            "Stored master unlock key is invalid",
        )
    })?);
    if decoded.len() != MASTER_UNLOCK_KEY_BYTES {
        return Err(RuntimeError::new(
            RuntimeErrorCode::AuthenticationRequired,
            "Stored master unlock key is invalid",
        ));
    }

    let mut master_unlock_key = Zeroizing::new([0_u8; MASTER_UNLOCK_KEY_BYTES]);
    master_unlock_key.copy_from_slice(&decoded);
    Ok(master_unlock_key)
}

/// Converts authenticated Server expiry evidence to the Runtime's millisecond clock domain.
pub(crate) fn parse_session_expiry_ms(expires_at: &str) -> Result<u64, RuntimeError> {
    let timestamp = OffsetDateTime::parse(expires_at, &Rfc3339)
        .map_err(|_| invalid_session_expiry())?
        .unix_timestamp_nanos();

    timestamp_nanos_to_ms(timestamp)
}

fn timestamp_nanos_to_ms(timestamp: i128) -> Result<u64, RuntimeError> {
    if timestamp < 0 {
        return Err(invalid_session_expiry());
    }

    u64::try_from(timestamp / NANOS_PER_MILLISECOND).map_err(|_| invalid_session_expiry())
}

fn invalid_session_expiry() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::AuthenticationUnavailable,
        "Server Session expiry is invalid",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const MUK: [u8; MASTER_UNLOCK_KEY_BYTES] = [0xA5; MASTER_UNLOCK_KEY_BYTES];
    const DEVICE_KEY: [u8; MASTER_UNLOCK_KEY_BYTES] = [0x3C; MASTER_UNLOCK_KEY_BYTES];

    #[test]
    fn wrapper_encrypts_the_standard_base64_plaintext_without_aad() {
        let wrapped = wrap_master_unlock_key(&MUK, &DEVICE_KEY).unwrap();

        assert_eq!(
            decrypt(&wrapped, &DEVICE_KEY).unwrap(),
            "paWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaU="
        );
        assert_eq!(wrapped.algorithm, "AES-GCM-AAD-V1");
    }

    #[test]
    fn wrapped_master_unlock_key_roundtrips_exactly() {
        let wrapped = wrap_master_unlock_key(&MUK, &DEVICE_KEY).unwrap();

        assert_eq!(
            *unwrap_master_unlock_key(&wrapped, &DEVICE_KEY).unwrap(),
            MUK
        );
    }

    #[test]
    fn unwrap_rejects_malformed_base64_and_wrong_length() {
        for plaintext in ["not base64", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="] {
            let wrapped = encrypt(plaintext, &DEVICE_KEY).unwrap();
            let error = unwrap_master_unlock_key(&wrapped, &DEVICE_KEY).unwrap_err();
            assert_eq!(error.code, RuntimeErrorCode::AuthenticationRequired);
        }
    }

    #[test]
    fn deterministic_clock_returns_its_fixed_milliseconds() {
        assert_eq!(
            FixedClock(1_777_777_777_123).now_ms().unwrap(),
            1_777_777_777_123
        );
    }

    #[test]
    fn session_expiry_parses_rfc3339_into_milliseconds() {
        assert_eq!(
            parse_session_expiry_ms("1970-01-01T00:00:01.23456789Z").unwrap(),
            1_234
        );
        assert_eq!(
            parse_session_expiry_ms("1970-01-01T01:00:01.234+01:00").unwrap(),
            1_234
        );
    }

    #[test]
    fn session_expiry_rejects_malformed_and_pre_epoch_values() {
        for expires_at in [
            "2026-08-23T12:34:56",
            "not-a-date",
            "1969-12-31T23:59:59.999999999Z",
            "+999999-01-01T00:00:00Z",
        ] {
            let error = parse_session_expiry_ms(expires_at).unwrap_err();
            assert_eq!(error.code, RuntimeErrorCode::AuthenticationUnavailable);
        }

        assert_eq!(
            timestamp_nanos_to_ms(i128::MAX).unwrap_err().code,
            RuntimeErrorCode::AuthenticationUnavailable
        );
    }
}
