//! Native-host-only cache crypto. The renderer has no Tauri crypto command surface.

use base64::{engine::general_purpose::STANDARD, Engine};
use bittery_crypto_core::{
    decrypt as core_decrypt, decrypt_with_aad, rsa_decrypt as core_rsa_decrypt, AadContext,
    EncryptedData,
};

fn decode_key(key_base64: String) -> Result<Vec<u8>, String> {
    STANDARD
        .decode(key_base64)
        .map_err(|error| format!("Invalid key base64: {error}"))
}

pub(crate) fn decrypt(
    ciphertext: String,
    iv: String,
    algorithm: String,
    key_base64: String,
) -> Result<String, String> {
    let key = decode_key(key_base64)?;
    let data = EncryptedData {
        ciphertext,
        iv,
        algorithm,
    };

    core_decrypt(&data, &key).map_err(|error| error.to_string())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn decrypt_with_context(
    ciphertext: String,
    iv: String,
    algorithm: String,
    key_base64: String,
    vault_id: String,
    entity_id: String,
    entity_type: String,
    version: u64,
    user_id: String,
) -> Result<String, String> {
    let key = decode_key(key_base64)?;
    let data = EncryptedData {
        ciphertext,
        iv,
        algorithm,
    };
    let context = AadContext {
        vault_id,
        entity_id,
        entity_type,
        version,
        user_id,
    };

    decrypt_with_aad(&data, &key, &context).map_err(|error| error.to_string())
}

pub(crate) fn rsa_decrypt(ciphertext: String, private_key_pem: String) -> Result<String, String> {
    core_rsa_decrypt(&ciphertext, &private_key_pem).map_err(|error| error.to_string())
}
