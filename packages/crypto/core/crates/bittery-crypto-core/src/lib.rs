//! Bittery Crypto Core
//!
//! Core cryptographic primitives for the Bittery password manager.
//! Implements zero-knowledge authentication and end-to-end encryption.

pub mod encryption;
pub mod error;
pub mod key_derivation;
pub mod key_rotation;
pub mod passkey;
pub mod rsa;
pub mod secret_key;
pub mod srp6a;

pub use encryption::{decrypt, encrypt, generate_encryption_key, EncryptedData};
pub use error::CryptoError;
pub use key_derivation::{derive_keys, DerivedKeys};
pub use key_rotation::{
    encrypt_vault_key_for_member, encrypt_vault_key_with_muk, perform_key_rotation,
    re_encrypt_item, validate_rotation_data, ItemData, KeyRotationResult, MemberEncryptedKey,
    MemberKeyData, ReEncryptedItem, ValidationResult,
};
pub use passkey::{
    build_attestation_object, build_authenticator_data, build_passkey_attestation_object,
    generate_credential_id, generate_passkey_keypair, sign_assertion, sign_passkey_assertion,
    AttestedCredentialData, PasskeyAssertion, PasskeyAttestation, PasskeyKeypair, FLAG_AT, FLAG_BE,
    FLAG_BS, FLAG_UP, FLAG_UV, PASSKEY_AAGUID,
};
pub use rsa::{generate_rsa_key_pair, rsa_decrypt, rsa_encrypt, RsaKeyPair};
pub use secret_key::{generate_secret_key, get_secret_key_hint, validate_secret_key};
pub use srp6a::{SrpClient, SrpServer};
