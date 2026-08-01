//! BigInt wrapper for SRP operations
//!
//! Provides padding support for consistent hex encoding, which is critical
//! for SRP protocol compatibility.

use num_bigint::BigUint;
use num_traits::Zero;
use rand::Rng;
use subtle::ConstantTimeEq;
use zeroize::Zeroize;

use crate::error::CryptoError;
use crate::system_rng;

/// SRP integer with optional hex length for padding
#[derive(Clone, Debug)]
pub struct SrpInt {
    value: BigUint,
    hex_length: Option<usize>,
}

impl SrpInt {
    /// Create a new SrpInt with no specified length
    pub fn new(value: BigUint) -> Self {
        Self {
            value,
            hex_length: None,
        }
    }

    /// Create a new SrpInt with specified hex length for padding
    pub fn with_length(value: BigUint, hex_length: usize) -> Self {
        Self {
            value,
            hex_length: Some(hex_length),
        }
    }

    /// Zero value
    #[allow(dead_code)]
    pub fn zero() -> Self {
        Self::new(BigUint::zero())
    }

    /// Parse from hex string (with optional whitespace)
    pub fn from_hex(hex: &str) -> Result<Self, CryptoError> {
        let cleaned: String = hex.chars().filter(|c| !c.is_whitespace()).collect();
        if cleaned.is_empty() {
            return Err(CryptoError::InvalidInput(
                "Hex string cannot be empty".to_string(),
            ));
        }
        if !cleaned.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(CryptoError::InvalidInput("Invalid hex string".to_string()));
        }
        let hex_length = cleaned.len();
        let value = BigUint::parse_bytes(cleaned.as_bytes(), 16)
            .ok_or_else(|| CryptoError::InvalidInput("Invalid hex string".to_string()))?;
        Ok(Self {
            value,
            hex_length: Some(hex_length),
        })
    }

    /// Generate random value with specified byte length
    pub fn random(bytes: usize) -> Self {
        let mut rng = system_rng();
        let mut buffer = vec![0u8; bytes];
        rng.fill_bytes(&mut buffer);
        let value = BigUint::from_bytes_be(&buffer);
        Self {
            value,
            hex_length: Some(bytes * 2),
        }
    }

    /// Get the underlying BigUint
    #[allow(dead_code)]
    pub fn value(&self) -> &BigUint {
        &self.value
    }

    /// Get hex length for padding
    #[allow(dead_code)]
    pub fn hex_length(&self) -> Option<usize> {
        self.hex_length
    }

    /// Convert to padded hex string
    ///
    /// # Panics
    /// Panics if hex_length is not set
    pub fn to_hex(&self) -> String {
        let hex_length = self.hex_length.expect("SrpInt has no specified hex length");
        let hex = self.value.to_str_radix(16);
        if hex.len() < hex_length {
            format!("{:0>width$}", hex, width = hex_length)
        } else {
            hex
        }
    }

    /// Convert to bytes
    #[allow(dead_code)]
    pub fn to_bytes(&self) -> Vec<u8> {
        self.value.to_bytes_be()
    }

    /// Set padding length
    pub fn pad(&self, hex_length: usize) -> Self {
        if let Some(current) = self.hex_length {
            if hex_length < current {
                panic!("Cannot pad to shorter length");
            }
        }
        Self {
            value: self.value.clone(),
            hex_length: Some(hex_length),
        }
    }

    /// Check if zero
    pub fn is_zero(&self) -> bool {
        self.value.is_zero()
    }

    /// Addition
    pub fn add(&self, other: &SrpInt) -> Self {
        Self::new(&self.value + &other.value)
    }

    /// Subtraction
    #[allow(dead_code)]
    pub fn subtract(&self, other: &SrpInt) -> Self {
        assert!(
            self.value >= other.value,
            "SrpInt::subtract underflow; use subtract_mod for modular subtraction"
        );
        Self {
            value: &self.value - &other.value,
            hex_length: self.hex_length,
        }
    }

    /// Modular subtraction
    pub fn subtract_mod(&self, other: &SrpInt, modulus: &SrpInt) -> Self {
        assert!(
            !modulus.is_zero(),
            "SrpInt::subtract_mod modulus cannot be zero"
        );
        let lhs = (&self.value % &modulus.value + &modulus.value - (&other.value % &modulus.value))
            % &modulus.value;
        Self {
            value: lhs,
            hex_length: modulus.hex_length,
        }
    }

    /// Multiplication
    pub fn multiply(&self, other: &SrpInt) -> Self {
        Self::new(&self.value * &other.value)
    }

    /// Modulo
    pub fn modulo(&self, modulus: &SrpInt) -> Self {
        Self {
            value: &self.value % &modulus.value,
            hex_length: modulus.hex_length,
        }
    }

    /// Modular exponentiation
    ///
    /// Not constant-time: `num_bigint::BigUint::modpow` uses a variable-window
    /// sliding-window exponentiation whose memory access pattern and iteration
    /// count depend on the exponent, and the intermediate multiplications are
    /// not masked. Most call sites pass a secret exponent (the ephemerals `a`
    /// and `b`, the password-derived `x`, and `a + u*x`).
    ///
    /// This is accepted for now because the alternative is replacing the bignum
    /// backend with a constant-time one, which is a large change to the most
    /// safety-critical arithmetic in the crate. The ephemeral exponents are
    /// freshly drawn per session, and the SRP handshake runs across a network
    /// boundary rather than co-resident with an attacker's measurement code.
    /// Revisit if SRP ever runs somewhere an attacker can observe the process.
    pub fn mod_pow(&self, exponent: &SrpInt, modulus: &SrpInt) -> Self {
        Self {
            value: self.value.modpow(&exponent.value, &modulus.value),
            hex_length: modulus.hex_length,
        }
    }

    /// XOR operation
    pub fn xor(&self, other: &SrpInt) -> Self {
        Self {
            value: &self.value ^ &other.value,
            hex_length: self.hex_length,
        }
    }

    /// Equality check
    pub fn equals(&self, other: &SrpInt) -> bool {
        let self_bytes = self.value.to_bytes_be();
        let other_bytes = other.value.to_bytes_be();
        let max_len = self_bytes.len().max(other_bytes.len());

        if max_len == 0 {
            return true;
        }

        let mut a = vec![0u8; max_len];
        let mut b = vec![0u8; max_len];
        a[max_len - self_bytes.len()..].copy_from_slice(&self_bytes);
        b[max_len - other_bytes.len()..].copy_from_slice(&other_bytes);

        let equals: bool = a.ct_eq(&b).into();
        a.zeroize();
        b.zeroize();
        equals
    }
}

impl From<BigUint> for SrpInt {
    fn from(value: BigUint) -> Self {
        Self::new(value)
    }
}

impl From<u32> for SrpInt {
    fn from(value: u32) -> Self {
        Self::new(BigUint::from(value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_from_hex() {
        let int = SrpInt::from_hex("0123456789abcdef").unwrap();
        assert_eq!(int.to_hex(), "0123456789abcdef");
    }

    #[test]
    fn test_from_hex_with_whitespace() {
        let int = SrpInt::from_hex("01 23 45 67 89 ab cd ef").unwrap();
        assert_eq!(int.to_hex(), "0123456789abcdef");
    }

    #[test]
    fn test_from_hex_invalid_returns_error() {
        assert!(SrpInt::from_hex("ZZZZ").is_err());
    }

    #[test]
    fn test_padding() {
        let int = SrpInt::from_hex("ff").unwrap();
        let padded = int.pad(8);
        assert_eq!(padded.to_hex(), "000000ff");
    }

    #[test]
    fn test_random() {
        let a = SrpInt::random(32);
        let b = SrpInt::random(32);
        assert!(!a.equals(&b));
        assert_eq!(a.hex_length(), Some(64));
    }

    #[test]
    fn test_mod_pow() {
        // 2^10 mod 1000 = 1024 mod 1000 = 24
        let base = SrpInt::from(2u32);
        let exp = SrpInt::from(10u32);
        let modulus = SrpInt::with_length(BigUint::from(1000u32), 4);
        let result = base.mod_pow(&exp, &modulus);
        assert_eq!(result.value(), &BigUint::from(24u32));
    }

    #[test]
    fn test_xor() {
        let a = SrpInt::from_hex("ff00").unwrap();
        let b = SrpInt::from_hex("0ff0").unwrap();
        let result = a.xor(&b);
        assert_eq!(result.value(), &BigUint::from(0xf0f0u32));
    }

    #[test]
    fn test_subtract_mod_underflow() {
        let a = SrpInt::from(3u32);
        let b = SrpInt::from(5u32);
        let modulus = SrpInt::with_length(BigUint::from(7u32), 2);
        let result = a.subtract_mod(&b, &modulus);
        assert_eq!(result.value(), &BigUint::from(5u32));
    }

    #[test]
    fn test_to_hex_zero_pads_values_shorter_than_the_modulus() {
        // g = 2 in the 1024-bit group: one significant byte, hashed as 128.
        let g = SrpInt::with_length(BigUint::from(2u32), 256);
        let hex = g.to_hex();

        assert_eq!(hex.len(), 256);
        assert!(hex.ends_with("02"));
        assert!(hex[..254].chars().all(|c| c == '0'));
        assert_eq!(hex::decode(&hex).unwrap().len(), 128);
    }

    #[test]
    fn test_mod_pow_result_is_padded_to_the_modulus_width() {
        // 2^3 mod 1000 = 8, whose natural big-endian encoding is one byte while
        // the modulus is 32. A missing pad here would silently shorten every
        // hash input derived from S, B or v.
        let base = SrpInt::from(2u32);
        let exp = SrpInt::from(3u32);
        let modulus = SrpInt::with_length(BigUint::from(1000u32), 64);

        let result = base.mod_pow(&exp, &modulus);

        assert_eq!(result.value(), &BigUint::from(8u32));
        assert_eq!(
            result.to_hex(),
            "0000000000000000000000000000000000000000000000000000000000000008"
        );
    }

    #[test]
    fn test_equals_pads_operands_of_different_byte_length() {
        // Exercises the pad-then-ct_eq path: same numeric value, different
        // natural byte lengths.
        let short = SrpInt::from_hex("ff").unwrap();
        let long = SrpInt::from_hex("00000000ff").unwrap();
        let shifted = SrpInt::from_hex("ff00").unwrap();

        assert!(short.equals(&long));
        assert!(long.equals(&short));
        assert!(!short.equals(&shifted));
    }

    #[test]
    fn test_equals_treats_zero_and_empty_encoding_as_equal() {
        // `BigUint::to_bytes_be` yields a single 0x00 byte for zero; make sure
        // the max_len == 0 short-circuit and the padded compare agree.
        let a = SrpInt::zero();
        let b = SrpInt::from_hex("0000").unwrap();

        assert!(a.equals(&b));
        assert!(!a.equals(&SrpInt::from(1u32)));
    }

    #[test]
    fn test_equals_for_equal_and_unequal_values() {
        let a = SrpInt::from_hex("0abc").unwrap();
        let b = SrpInt::from_hex("0ABC").unwrap();
        let c = SrpInt::from_hex("0abd").unwrap();

        assert!(a.equals(&b));
        assert!(!a.equals(&c));
    }
}
