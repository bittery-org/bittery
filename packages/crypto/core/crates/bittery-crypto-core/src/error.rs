//! Error types for cryptographic operations

use thiserror::Error;

/// Errors that can occur during cryptographic operations
#[derive(Error, Debug)]
pub enum CryptoError {
    #[error("Key derivation failed: {0}")]
    KeyDerivation(String),

    #[error("Encryption failed: {0}")]
    Encryption(String),

    #[error("Decryption failed: {0}")]
    Decryption(String),

    #[error("Invalid key length: expected {expected}, got {actual}")]
    InvalidKeyLength { expected: usize, actual: usize },

    #[error("Invalid IV length: expected {expected}, got {actual}")]
    InvalidIvLength { expected: usize, actual: usize },

    #[error("RSA operation failed: {0}")]
    Rsa(String),

    #[error("Invalid PEM format: {0}")]
    InvalidPem(String),

    #[error("Invalid secret key format")]
    InvalidSecretKey,

    #[error("Base64 decode error: {0}")]
    Base64Decode(String),

    #[error("Hex decode error: {0}")]
    HexDecode(String),

    #[error("SRP error: {0}")]
    Srp(String),

    #[error("Invalid public ephemeral")]
    InvalidPublicEphemeral,

    #[error("Invalid session proof")]
    InvalidSessionProof,

    #[error("UTF-8 decode error: {0}")]
    Utf8Error(String),

    #[error("Invalid input: {0}")]
    InvalidInput(String),
}

impl From<base64::DecodeError> for CryptoError {
    fn from(e: base64::DecodeError) -> Self {
        CryptoError::Base64Decode(e.to_string())
    }
}

impl From<hex::FromHexError> for CryptoError {
    fn from(e: hex::FromHexError) -> Self {
        CryptoError::HexDecode(e.to_string())
    }
}

impl From<std::string::FromUtf8Error> for CryptoError {
    fn from(e: std::string::FromUtf8Error) -> Self {
        CryptoError::Utf8Error(e.to_string())
    }
}
