//! Bittery Crypto Core
//!
//! Core cryptographic primitives for the Bittery password manager.
//! Implements zero-knowledge authentication and end-to-end encryption.

pub mod encryption;
pub mod error;
pub mod key_derivation;
pub mod kdf_policy;
pub mod key_rotation;
pub mod passkey;
pub mod recovery;
pub mod rsa;
pub mod secret_key;
pub mod srp6a;
pub mod totp;
pub mod uuid;

pub use encryption::{
    decrypt, decrypt_with_aad, encrypt, encrypt_with_aad, generate_encryption_key, AadContext,
    EncryptedData,
};
pub use error::CryptoError;
pub use key_derivation::{derive_keys, derive_keys_from_master_key, derive_master_key, DerivedKeys};
pub use kdf_policy::{
    default_login_kdf_params, validate_server_kdf_params, KdfParams, KDF_ALGORITHM_PBKDF2_SHA256,
    KDF_SCHEMA_VERSION, MIN_PBKDF2_ITERATIONS,
};
pub use key_rotation::{
    decrypt_vault_key_with_muk, encrypt_vault_key_for_member, encrypt_vault_key_with_muk,
    perform_key_rotation, re_encrypt_item, validate_rotation_data, ItemData, KeyRotationResult,
    MemberEncryptedKey, MemberKeyData, ReEncryptedItem, ValidationResult,
    VaultKeyWrapContext, WrappedVaultKeyData, VAULT_KEY_WRAP_ENTITY_TYPE, VAULT_KEY_WRAP_PURPOSE,
};
pub use passkey::{
    build_attestation_object, build_authenticator_data, build_passkey_attestation_object,
    generate_credential_id, generate_passkey_keypair, sign_assertion, sign_passkey_assertion,
    AttestedCredentialData, PasskeyAssertion, PasskeyAttestation, PasskeyKeypair, FLAG_AT, FLAG_BE,
    FLAG_BS, FLAG_UP, FLAG_UV, PASSKEY_AAGUID,
};
pub use recovery::{
    decrypt_master_key, derive_recovery_encryption_key, encrypt_master_key, generate_recovery_key,
    validate_recovery_key,
};
pub use rsa::{generate_rsa_key_pair, rsa_decrypt, rsa_encrypt, RsaKeyPair};
pub use secret_key::{generate_secret_key, get_secret_key_hint, validate_secret_key};
pub use srp6a::{SrpClient, SrpServer};
pub use totp::{generate_totp, generate_totp_at, TotpResult};
pub use uuid::generate_uuid;
