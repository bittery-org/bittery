//! Bittery Crypto Core
//!
//! Core cryptographic primitives for the Bittery password manager.
//! Implements zero-knowledge authentication and end-to-end encryption.

pub mod encryption;
pub mod error;
pub mod key_derivation;
pub mod rsa;
pub mod secret_key;
pub mod srp6a;

pub use encryption::{decrypt, encrypt, generate_encryption_key, EncryptedData};
pub use error::CryptoError;
pub use key_derivation::{derive_keys, DerivedKeys};
pub use rsa::{generate_rsa_key_pair, rsa_decrypt, rsa_encrypt, RsaKeyPair};
pub use secret_key::{generate_secret_key, get_secret_key_hint, validate_secret_key};
pub use srp6a::{SrpClient, SrpServer};
