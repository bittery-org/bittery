//! BigInt wrapper for SRP operations
//!
//! Provides padding support for consistent hex encoding, which is critical
//! for SRP protocol compatibility.

use num_bigint::BigUint;
use num_traits::Zero;
use rand::RngCore;

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
    pub fn from_hex(hex: &str) -> Self {
        let cleaned: String = hex
            .chars()
            .filter(|c| c.is_ascii_hexdigit())
            .collect::<String>()
            .to_lowercase();
        let hex_length = cleaned.len();
        let value = BigUint::parse_bytes(cleaned.as_bytes(), 16)
            .unwrap_or_else(BigUint::zero);
        Self {
            value,
            hex_length: Some(hex_length),
        }
    }

    /// Generate random value with specified byte length
    pub fn random(bytes: usize) -> Self {
        let mut rng = rand::thread_rng();
        let mut buffer = vec![0u8; bytes];
        rng.fill_bytes(&mut buffer);
        let value = BigUint::from_bytes_be(&buffer);
        Self {
            value,
            hex_length: Some(bytes * 2),
        }
    }

    /// Get the underlying BigUint
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
    pub fn subtract(&self, other: &SrpInt) -> Self {
        // Handle underflow by working mod N in calling code
        if self.value >= other.value {
            Self {
                value: &self.value - &other.value,
                hex_length: self.hex_length,
            }
        } else {
            // This shouldn't happen in correct SRP calculations
            Self::new(BigUint::zero())
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
        self.value == other.value
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
        let int = SrpInt::from_hex("0123456789abcdef");
        assert_eq!(int.to_hex(), "0123456789abcdef");
    }

    #[test]
    fn test_from_hex_with_whitespace() {
        let int = SrpInt::from_hex("01 23 45 67 89 ab cd ef");
        assert_eq!(int.to_hex(), "0123456789abcdef");
    }

    #[test]
    fn test_padding() {
        let int = SrpInt::from_hex("ff");
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
        let a = SrpInt::from_hex("ff00");
        let b = SrpInt::from_hex("0ff0");
        let result = a.xor(&b);
        assert_eq!(result.value(), &BigUint::from(0xf0f0u32));
    }
}
