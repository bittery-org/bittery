//! JNI bindings for Android
//!
//! This module provides JNI-compatible functions that wrap the FFI functions
//! for use with React Native on Android.
//!
//! # Wiping key material
//!
//! Rust owns only the copies it makes on this side of the boundary, and those
//! are wiped. Two things are outside its reach:
//!
//! * A `java.lang.String` argument lives on the JVM heap. `JNIEnv::get_string`
//!   copies it into a Rust `String` (the copy is wiped here), but neither the
//!   original nor the temporary buffer the JNI runtime hands out during the copy
//!   can be cleared from Rust.
//! * A `jstring` returned from these functions has been copied into the JVM heap
//!   by `JNIEnv::new_string`. It is garbage-collected and cannot be wiped from
//!   Rust; clearing it is the Kotlin/Java caller's problem.

#![cfg(target_os = "android")]

use ::jni::objects::{JClass, JObject, JString, JValue};
use ::jni::sys::{jboolean, jint, jlong, JNI_FALSE, JNI_TRUE};
use ::jni::JNIEnv;
use zeroize::{Zeroize, Zeroizing};

// This module reimplements the crypto calls against the JNI types rather than
// wrapping the `extern "C"` surface in lib.rs, so there is nothing to import
// from the crate root. A glob import here would only mask that.

// ============================================================================
// Helper Functions
// ============================================================================

fn get_string(env: &mut JNIEnv, s: JString) -> Option<String> {
    env.get_string(&s).ok().map(|s| s.into())
}

/// Copy a `java.lang.String` argument that carries secret material into a Rust
/// `String` that is wiped when it goes out of scope.
///
/// Only the Rust-side copy is wiped; see the module docs for what stays on the
/// JVM heap.
fn get_secret_string(env: &mut JNIEnv, s: JString) -> Option<Zeroizing<String>> {
    get_string(env, s).map(Zeroizing::new)
}

/// Build a `jstring`.
///
/// The bytes are copied into the JVM heap, so a secret passed here exists in two
/// places from this point on and only the Rust-side copy can be wiped.
fn new_string<'a>(env: &mut JNIEnv<'a>, s: &str) -> JString<'a> {
    env.new_string(s).unwrap_or_else(|_| JString::default())
}

fn create_derived_keys_result<'a>(
    env: &mut JNIEnv<'a>,
    auth_key: Option<&str>,
    master_unlock_key: Option<&str>,
    error: Option<&str>,
) -> JObject<'a> {
    let class = env
        .find_class("expo/modules/bitterycrypto/BitteryCryptoModule$DerivedKeysResult")
        .unwrap();

    let auth_key_str = auth_key.map(|s| new_string(env, s)).unwrap_or_default();
    let muk_str = master_unlock_key
        .map(|s| new_string(env, s))
        .unwrap_or_default();
    let error_str = error.map(|s| new_string(env, s)).unwrap_or_default();

    env.new_object(
        class,
        "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V",
        &[
            JValue::Object(&auth_key_str),
            JValue::Object(&muk_str),
            JValue::Object(&error_str),
        ],
    )
    .unwrap()
}

fn create_encrypt_result<'a>(
    env: &mut JNIEnv<'a>,
    ciphertext: Option<&str>,
    iv: Option<&str>,
    algorithm: Option<&str>,
    error: Option<&str>,
) -> JObject<'a> {
    let class = env
        .find_class("expo/modules/bitterycrypto/BitteryCryptoModule$EncryptResult")
        .unwrap();

    let ct_str = ciphertext.map(|s| new_string(env, s)).unwrap_or_default();
    let iv_str = iv.map(|s| new_string(env, s)).unwrap_or_default();
    let alg_str = algorithm.map(|s| new_string(env, s)).unwrap_or_default();
    let error_str = error.map(|s| new_string(env, s)).unwrap_or_default();

    env.new_object(
        class,
        "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V",
        &[
            JValue::Object(&ct_str),
            JValue::Object(&iv_str),
            JValue::Object(&alg_str),
            JValue::Object(&error_str),
        ],
    )
    .unwrap()
}

fn create_rsa_keypair_result<'a>(
    env: &mut JNIEnv<'a>,
    public_key: Option<&str>,
    private_key: Option<&str>,
    error: Option<&str>,
) -> JObject<'a> {
    let class = env
        .find_class("expo/modules/bitterycrypto/BitteryCryptoModule$RsaKeyPairResult")
        .unwrap();

    let pub_str = public_key.map(|s| new_string(env, s)).unwrap_or_default();
    let priv_str = private_key.map(|s| new_string(env, s)).unwrap_or_default();
    let error_str = error.map(|s| new_string(env, s)).unwrap_or_default();

    env.new_object(
        class,
        "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V",
        &[
            JValue::Object(&pub_str),
            JValue::Object(&priv_str),
            JValue::Object(&error_str),
        ],
    )
    .unwrap()
}

fn create_ephemeral_result<'a>(env: &mut JNIEnv<'a>, public: &str, secret: &str) -> JObject<'a> {
    let class = env
        .find_class("expo/modules/bitterycrypto/BitteryCryptoModule$EphemeralResult")
        .unwrap();

    let pub_str = new_string(env, public);
    let secret_str = new_string(env, secret);

    env.new_object(
        class,
        "(Ljava/lang/String;Ljava/lang/String;)V",
        &[JValue::Object(&pub_str), JValue::Object(&secret_str)],
    )
    .unwrap()
}

fn create_session_result<'a>(
    env: &mut JNIEnv<'a>,
    key: Option<&str>,
    proof: Option<&str>,
    error: Option<&str>,
) -> JObject<'a> {
    let class = env
        .find_class("expo/modules/bitterycrypto/BitteryCryptoModule$SessionResult")
        .unwrap();

    let key_str = key.map(|s| new_string(env, s)).unwrap_or_default();
    let proof_str = proof.map(|s| new_string(env, s)).unwrap_or_default();
    let error_str = error.map(|s| new_string(env, s)).unwrap_or_default();

    env.new_object(
        class,
        "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V",
        &[
            JValue::Object(&key_str),
            JValue::Object(&proof_str),
            JValue::Object(&error_str),
        ],
    )
    .unwrap()
}

// ============================================================================
// Key Derivation
// ============================================================================

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeDeriveKeys<'a>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    password: JString<'a>,
    secret_key: JString<'a>,
    email: JString<'a>,
    schema_version: jint,
    algorithm: JString<'a>,
    iterations: jint,
) -> JObject<'a> {
    let password_str = match get_secret_string(&mut env, password) {
        Some(s) => s,
        None => return create_derived_keys_result(&mut env, None, None, Some("Invalid password")),
    };
    let secret_str = match get_secret_string(&mut env, secret_key) {
        Some(s) => s,
        None => {
            return create_derived_keys_result(&mut env, None, None, Some("Invalid secret key"))
        }
    };
    let email_str = match get_string(&mut env, email) {
        Some(s) => s,
        None => return create_derived_keys_result(&mut env, None, None, Some("Invalid email")),
    };

    use base64::{engine::general_purpose::STANDARD, Engine};
    use bittery_crypto_core::{derive_keys, KdfProfile};
    let algorithm_str = match get_string(&mut env, algorithm) {
        Some(value) => value,
        None => {
            return create_derived_keys_result(&mut env, None, None, Some("Invalid KDF algorithm"))
        }
    };
    if schema_version != 1 || !(600_000..=1_200_000).contains(&iterations) {
        return create_derived_keys_result(&mut env, None, None, Some("Invalid KDF profile"));
    }
    let schema_version = schema_version as u32;
    let iterations = iterations as u32;
    let profile = KdfProfile {
        schema_version,
        algorithm: algorithm_str,
        iterations,
    };

    match derive_keys(&password_str, &secret_str, &email_str, &profile) {
        Ok(keys) => {
            let mut auth_key = STANDARD.encode(&keys.auth_key);
            let mut muk = STANDARD.encode(&keys.master_unlock_key);
            let result = create_derived_keys_result(&mut env, Some(&auth_key), Some(&muk), None);
            auth_key.zeroize();
            muk.zeroize();
            result
        }
        Err(e) => create_derived_keys_result(&mut env, None, None, Some(&e.to_string())),
    }
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeDeriveMasterKey<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    account_password: JString<'a>,
    secret_key: JString<'a>,
    email: JString<'a>,
    schema_version: jint,
    algorithm: JString<'a>,
    iterations: jint,
) -> JString<'a> {
    let password_str = match get_secret_string(&mut env, account_password) {
        Some(s) => s,
        None => return new_string(&mut env, "ERROR:Invalid password"),
    };
    let secret_str = match get_secret_string(&mut env, secret_key) {
        Some(s) => s,
        None => return new_string(&mut env, "ERROR:Invalid secret key"),
    };
    let email_str = match get_string(&mut env, email) {
        Some(s) => s,
        None => return new_string(&mut env, "ERROR:Invalid email"),
    };

    use base64::{engine::general_purpose::STANDARD, Engine};
    use bittery_crypto_core::{derive_master_key, KdfProfile};
    let algorithm_str = match get_string(&mut env, algorithm) {
        Some(value) => value,
        None => return new_string(&mut env, "ERROR:Invalid KDF algorithm"),
    };
    if schema_version != 1 || !(600_000..=1_200_000).contains(&iterations) {
        return new_string(&mut env, "ERROR:Invalid KDF profile");
    }
    let schema_version = schema_version as u32;
    let iterations = iterations as u32;
    let profile = KdfProfile {
        schema_version,
        algorithm: algorithm_str,
        iterations,
    };

    match derive_master_key(&password_str, &secret_str, &email_str, &profile) {
        Ok(mut master_key) => {
            let mut encoded = STANDARD.encode(master_key.as_slice());
            master_key.zeroize();
            let result = new_string(&mut env, &encoded);
            encoded.zeroize();
            result
        }
        Err(e) => new_string(&mut env, &format!("ERROR:{}", e)),
    }
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeDeriveKeysFromMasterKey<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    master_key_base64: JString<'a>,
    email: JString<'a>,
) -> JObject<'a> {
    let master_key_str = match get_secret_string(&mut env, master_key_base64) {
        Some(s) => s,
        None => {
            return create_derived_keys_result(&mut env, None, None, Some("Invalid master key"))
        }
    };
    let email_str = match get_string(&mut env, email) {
        Some(s) => s,
        None => return create_derived_keys_result(&mut env, None, None, Some("Invalid email")),
    };

    use base64::{engine::general_purpose::STANDARD, Engine};
    use bittery_crypto_core::derive_keys_from_master_key;

    let master_key = match STANDARD.decode(&master_key_str) {
        Ok(k) => Zeroizing::new(k),
        Err(e) => {
            return create_derived_keys_result(
                &mut env,
                None,
                None,
                Some(&format!("Invalid master key base64: {}", e)),
            )
        }
    };

    match derive_keys_from_master_key(&master_key, &email_str) {
        Ok(keys) => {
            let mut auth_key = STANDARD.encode(&keys.auth_key);
            let mut muk = STANDARD.encode(&keys.master_unlock_key);
            let result = create_derived_keys_result(&mut env, Some(&auth_key), Some(&muk), None);
            auth_key.zeroize();
            muk.zeroize();
            result
        }
        Err(e) => create_derived_keys_result(&mut env, None, None, Some(&e.to_string())),
    }
}

// ============================================================================
// AES-256-GCM Encryption
// ============================================================================

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeEncrypt<'a>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    plaintext: JString<'a>,
    key_base64: JString<'a>,
) -> JObject<'a> {
    let plaintext_str = match get_secret_string(&mut env, plaintext) {
        Some(s) => s,
        None => {
            return create_encrypt_result(&mut env, None, None, None, Some("Invalid plaintext"))
        }
    };
    let key_str = match get_secret_string(&mut env, key_base64) {
        Some(s) => s,
        None => return create_encrypt_result(&mut env, None, None, None, Some("Invalid key")),
    };

    use base64::{engine::general_purpose::STANDARD, Engine};
    use bittery_crypto_core::encrypt;

    let key = match STANDARD.decode(&key_str) {
        Ok(k) => Zeroizing::new(k),
        Err(e) => {
            return create_encrypt_result(
                &mut env,
                None,
                None,
                None,
                Some(&format!("Invalid key base64: {}", e)),
            )
        }
    };

    match encrypt(&plaintext_str, &key) {
        Ok(encrypted) => create_encrypt_result(
            &mut env,
            Some(&encrypted.ciphertext),
            Some(&encrypted.iv),
            Some(&encrypted.algorithm),
            None,
        ),
        Err(e) => create_encrypt_result(&mut env, None, None, None, Some(&e.to_string())),
    }
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeDecrypt<'a>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    ciphertext: JString<'a>,
    iv: JString<'a>,
    algorithm: JString<'a>,
    key_base64: JString<'a>,
) -> JString<'a> {
    let ciphertext_str = match get_string(&mut env, ciphertext) {
        Some(s) => s,
        None => return new_string(&mut env, "ERROR:Invalid ciphertext"),
    };
    let iv_str = match get_string(&mut env, iv) {
        Some(s) => s,
        None => return new_string(&mut env, "ERROR:Invalid IV"),
    };
    let algorithm_str = match get_string(&mut env, algorithm) {
        Some(s) => s,
        None => return new_string(&mut env, "ERROR:Invalid algorithm"),
    };
    let key_str = match get_secret_string(&mut env, key_base64) {
        Some(s) => s,
        None => return new_string(&mut env, "ERROR:Invalid key"),
    };

    use base64::{engine::general_purpose::STANDARD, Engine};
    use bittery_crypto_core::{decrypt, EncryptedData};

    let key = match STANDARD.decode(&key_str) {
        Ok(k) => Zeroizing::new(k),
        Err(e) => return new_string(&mut env, &format!("ERROR:Invalid key base64: {}", e)),
    };

    let data = EncryptedData {
        ciphertext: ciphertext_str,
        iv: iv_str,
        algorithm: algorithm_str,
    };

    match decrypt(&data, &key) {
        Ok(mut plaintext) => {
            let result = new_string(&mut env, &plaintext);
            plaintext.zeroize();
            result
        }
        Err(e) => new_string(&mut env, &format!("ERROR:{}", e)),
    }
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeEncryptWithContext<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    plaintext: JString<'a>,
    key_base64: JString<'a>,
    vault_id: JString<'a>,
    entity_id: JString<'a>,
    entity_type: JString<'a>,
    version: jlong,
    user_id: JString<'a>,
) -> JObject<'a> {
    let plaintext_str = match get_secret_string(&mut env, plaintext) {
        Some(s) => s,
        None => {
            return create_encrypt_result(&mut env, None, None, None, Some("Invalid plaintext"))
        }
    };
    let key_str = match get_secret_string(&mut env, key_base64) {
        Some(s) => s,
        None => return create_encrypt_result(&mut env, None, None, None, Some("Invalid key")),
    };
    let vault_id_str = match get_string(&mut env, vault_id) {
        Some(s) => s,
        None => return create_encrypt_result(&mut env, None, None, None, Some("Invalid vault_id")),
    };
    let entity_id_str = match get_string(&mut env, entity_id) {
        Some(s) => s,
        None => {
            return create_encrypt_result(&mut env, None, None, None, Some("Invalid entity_id"))
        }
    };
    let entity_type_str = match get_string(&mut env, entity_type) {
        Some(s) => s,
        None => {
            return create_encrypt_result(&mut env, None, None, None, Some("Invalid entity_type"))
        }
    };
    let user_id_str = match get_string(&mut env, user_id) {
        Some(s) => s,
        None => return create_encrypt_result(&mut env, None, None, None, Some("Invalid user_id")),
    };

    use base64::{engine::general_purpose::STANDARD, Engine};
    use bittery_crypto_core::{encrypt_with_aad, AadContext};

    let key = match STANDARD.decode(&key_str) {
        Ok(k) => Zeroizing::new(k),
        Err(e) => {
            return create_encrypt_result(
                &mut env,
                None,
                None,
                None,
                Some(&format!("Invalid key base64: {}", e)),
            )
        }
    };

    let context = AadContext {
        vault_id: vault_id_str,
        entity_id: entity_id_str,
        entity_type: entity_type_str,
        version: version as u64,
        user_id: user_id_str,
    };

    match encrypt_with_aad(&plaintext_str, &key, &context) {
        Ok(encrypted) => create_encrypt_result(
            &mut env,
            Some(&encrypted.ciphertext),
            Some(&encrypted.iv),
            Some(&encrypted.algorithm),
            None,
        ),
        Err(e) => create_encrypt_result(&mut env, None, None, None, Some(&e.to_string())),
    }
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeDecryptWithContext<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    ciphertext: JString<'a>,
    iv: JString<'a>,
    algorithm: JString<'a>,
    key_base64: JString<'a>,
    vault_id: JString<'a>,
    entity_id: JString<'a>,
    entity_type: JString<'a>,
    version: jlong,
    user_id: JString<'a>,
) -> JString<'a> {
    let ciphertext_str = match get_string(&mut env, ciphertext) {
        Some(s) => s,
        None => return new_string(&mut env, "ERROR:Invalid ciphertext"),
    };
    let iv_str = match get_string(&mut env, iv) {
        Some(s) => s,
        None => return new_string(&mut env, "ERROR:Invalid IV"),
    };
    let algorithm_str = match get_string(&mut env, algorithm) {
        Some(s) => s,
        None => return new_string(&mut env, "ERROR:Invalid algorithm"),
    };
    let key_str = match get_secret_string(&mut env, key_base64) {
        Some(s) => s,
        None => return new_string(&mut env, "ERROR:Invalid key"),
    };
    let vault_id_str = match get_string(&mut env, vault_id) {
        Some(s) => s,
        None => return new_string(&mut env, "ERROR:Invalid vault_id"),
    };
    let entity_id_str = match get_string(&mut env, entity_id) {
        Some(s) => s,
        None => return new_string(&mut env, "ERROR:Invalid entity_id"),
    };
    let entity_type_str = match get_string(&mut env, entity_type) {
        Some(s) => s,
        None => return new_string(&mut env, "ERROR:Invalid entity_type"),
    };
    let user_id_str = match get_string(&mut env, user_id) {
        Some(s) => s,
        None => return new_string(&mut env, "ERROR:Invalid user_id"),
    };

    use base64::{engine::general_purpose::STANDARD, Engine};
    use bittery_crypto_core::{decrypt_with_aad, AadContext, EncryptedData};

    let key = match STANDARD.decode(&key_str) {
        Ok(k) => Zeroizing::new(k),
        Err(e) => return new_string(&mut env, &format!("ERROR:Invalid key base64: {}", e)),
    };

    let data = EncryptedData {
        ciphertext: ciphertext_str,
        iv: iv_str,
        algorithm: algorithm_str,
    };

    let context = AadContext {
        vault_id: vault_id_str,
        entity_id: entity_id_str,
        entity_type: entity_type_str,
        version: version as u64,
        user_id: user_id_str,
    };

    match decrypt_with_aad(&data, &key, &context) {
        Ok(mut plaintext) => {
            let result = new_string(&mut env, &plaintext);
            plaintext.zeroize();
            result
        }
        Err(e) => new_string(&mut env, &format!("ERROR:{}", e)),
    }
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeGenerateEncryptionKey<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
) -> JString<'a> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use bittery_crypto_core::generate_encryption_key;

    let mut key = generate_encryption_key();
    // `as_slice()` and not `key`: the key is a `[u8; 32]`, so passing it by
    // value would copy the key material onto the stack for the duration of
    // `encode` and leave that copy unwiped. Borrowing as a slice is what
    // `clippy::needless_borrows_for_generic_args` wants and keeps the single
    // wipeable copy.
    let mut encoded = STANDARD.encode(key.as_slice());
    key.zeroize();
    let result = new_string(&mut env, &encoded);
    encoded.zeroize();
    result
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeGenerateUuid<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
) -> JString<'a> {
    use bittery_crypto_core::generate_uuid;
    new_string(&mut env, &generate_uuid())
}

// ============================================================================
// RSA-4096
// ============================================================================

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeGenerateRsaKeyPair<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
) -> JObject<'a> {
    use bittery_crypto_core::generate_rsa_key_pair;

    // `RsaKeyPair` is `ZeroizeOnDrop` in the core, so the PKCS#8 private key is
    // wiped when `key_pair` drops at the end of this match.
    match generate_rsa_key_pair() {
        Ok(key_pair) => create_rsa_keypair_result(
            &mut env,
            Some(&key_pair.public_key),
            Some(&key_pair.private_key),
            None,
        ),
        Err(e) => create_rsa_keypair_result(&mut env, None, None, Some(&e.to_string())),
    }
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeRsaEncrypt<'a>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    plaintext: JString<'a>,
    public_key_pem: JString<'a>,
) -> JString<'a> {
    let plaintext_str = match get_secret_string(&mut env, plaintext) {
        Some(s) => s,
        None => return new_string(&mut env, "ERROR:Invalid plaintext"),
    };
    let pem = match get_string(&mut env, public_key_pem) {
        Some(s) => s,
        None => return new_string(&mut env, "ERROR:Invalid public key"),
    };

    use bittery_crypto_core::rsa_encrypt;

    match rsa_encrypt(&plaintext_str, &pem) {
        Ok(ciphertext) => new_string(&mut env, &ciphertext),
        Err(e) => new_string(&mut env, &format!("ERROR:{}", e)),
    }
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeRsaDecrypt<'a>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    ciphertext: JString<'a>,
    private_key_pem: JString<'a>,
) -> JString<'a> {
    let ciphertext_str = match get_string(&mut env, ciphertext) {
        Some(s) => s,
        None => return new_string(&mut env, "ERROR:Invalid ciphertext"),
    };
    let pem = match get_secret_string(&mut env, private_key_pem) {
        Some(s) => s,
        None => return new_string(&mut env, "ERROR:Invalid private key"),
    };

    use bittery_crypto_core::rsa_decrypt;

    match rsa_decrypt(&ciphertext_str, &pem) {
        Ok(mut plaintext) => {
            let result = new_string(&mut env, &plaintext);
            plaintext.zeroize();
            result
        }
        Err(e) => new_string(&mut env, &format!("ERROR:{}", e)),
    }
}

// ============================================================================
// Secret Key
// ============================================================================

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeGenerateSecretKey<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
) -> JString<'a> {
    use bittery_crypto_core::generate_secret_key;
    let mut secret_key = generate_secret_key();
    let result = new_string(&mut env, &secret_key);
    secret_key.zeroize();
    result
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeValidateSecretKey<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    secret_key: JString<'a>,
) -> jboolean {
    let key = match get_secret_string(&mut env, secret_key) {
        Some(s) => s,
        None => return JNI_FALSE,
    };

    use bittery_crypto_core::validate_secret_key;

    if validate_secret_key(&key) {
        JNI_TRUE
    } else {
        JNI_FALSE
    }
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeGetSecretKeyHint<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    secret_key: JString<'a>,
) -> JString<'a> {
    let key = match get_secret_string(&mut env, secret_key) {
        Some(s) => s,
        None => return JString::default(),
    };

    // The hint is the deliberately public prefix of the secret key.
    use bittery_crypto_core::get_secret_key_hint;
    new_string(&mut env, &get_secret_key_hint(&key))
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeGenerateRecoveryKey<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
) -> JString<'a> {
    use bittery_crypto_core::generate_recovery_key;
    let mut key = generate_recovery_key();
    let result = new_string(&mut env, &key);
    key.zeroize();
    result
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeValidateRecoveryKey<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    recovery_key: JString<'a>,
) -> jboolean {
    let key = match get_secret_string(&mut env, recovery_key) {
        Some(s) => s,
        None => return JNI_FALSE,
    };

    use bittery_crypto_core::validate_recovery_key;

    if validate_recovery_key(&key) {
        JNI_TRUE
    } else {
        JNI_FALSE
    }
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeEncryptMasterKey<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    master_key_base64: JString<'a>,
    recovery_key: JString<'a>,
    email: JString<'a>,
) -> JObject<'a> {
    let master_key_str = match get_secret_string(&mut env, master_key_base64) {
        Some(s) => s,
        None => {
            return create_encrypt_result(&mut env, None, None, None, Some("Invalid master key"))
        }
    };
    let recovery_key_str = match get_secret_string(&mut env, recovery_key) {
        Some(s) => s,
        None => {
            return create_encrypt_result(&mut env, None, None, None, Some("Invalid recovery key"))
        }
    };
    let email_str = match get_string(&mut env, email) {
        Some(s) => s,
        None => return create_encrypt_result(&mut env, None, None, None, Some("Invalid email")),
    };

    use base64::{engine::general_purpose::STANDARD, Engine};
    use bittery_crypto_core::encrypt_master_key;

    let master_key = match STANDARD.decode(&master_key_str) {
        Ok(k) => Zeroizing::new(k),
        Err(e) => {
            return create_encrypt_result(
                &mut env,
                None,
                None,
                None,
                Some(&format!("Invalid master key base64: {}", e)),
            )
        }
    };

    match encrypt_master_key(&master_key, &recovery_key_str, &email_str) {
        Ok(encrypted) => create_encrypt_result(
            &mut env,
            Some(&encrypted.ciphertext),
            Some(&encrypted.iv),
            Some(&encrypted.algorithm),
            None,
        ),
        Err(e) => create_encrypt_result(&mut env, None, None, None, Some(&e.to_string())),
    }
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeDecryptMasterKey<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    ciphertext: JString<'a>,
    iv: JString<'a>,
    algorithm: JString<'a>,
    recovery_key: JString<'a>,
    email: JString<'a>,
) -> JString<'a> {
    let ciphertext_str = match get_string(&mut env, ciphertext) {
        Some(s) => s,
        None => return new_string(&mut env, "ERROR:Invalid ciphertext"),
    };
    let iv_str = match get_string(&mut env, iv) {
        Some(s) => s,
        None => return new_string(&mut env, "ERROR:Invalid IV"),
    };
    let algorithm_str = match get_string(&mut env, algorithm) {
        Some(s) => s,
        None => return new_string(&mut env, "ERROR:Invalid algorithm"),
    };
    let recovery_key_str = match get_secret_string(&mut env, recovery_key) {
        Some(s) => s,
        None => return new_string(&mut env, "ERROR:Invalid recovery key"),
    };
    let email_str = match get_string(&mut env, email) {
        Some(s) => s,
        None => return new_string(&mut env, "ERROR:Invalid email"),
    };

    use base64::{engine::general_purpose::STANDARD, Engine};
    use bittery_crypto_core::{decrypt_master_key, EncryptedData};

    let data = EncryptedData {
        ciphertext: ciphertext_str,
        iv: iv_str,
        algorithm: algorithm_str,
    };

    match decrypt_master_key(&data, &recovery_key_str, &email_str) {
        Ok(mut master_key) => {
            let mut encoded = STANDARD.encode(master_key.as_slice());
            master_key.zeroize();
            let result = new_string(&mut env, &encoded);
            encoded.zeroize();
            result
        }
        Err(e) => new_string(&mut env, &format!("ERROR:{}", e)),
    }
}

// ============================================================================
// SRP-6a Client
// ============================================================================

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeSrpClientNew<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    hash_algorithm: JString<'a>,
    prime_group: jint,
) -> jlong {
    let hash_str = match get_string(&mut env, hash_algorithm) {
        Some(s) => s,
        None => return 0,
    };

    use bittery_crypto_core::srp6a::{HashAlgorithm, PrimeGroup, SrpClient};

    let hash = match hash_str.as_str() {
        "SHA-256" => HashAlgorithm::Sha256,
        _ => return 0,
    };

    let group = match prime_group {
        4096 => PrimeGroup::G4096,
        _ => return 0,
    };

    let client = Box::new(SrpClient::new(hash, group));
    Box::into_raw(client) as jlong
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeSrpClientFree<
    'a,
>(
    _env: JNIEnv<'a>,
    _class: JClass<'a>,
    handle: jlong,
) {
    if handle != 0 {
        use bittery_crypto_core::srp6a::SrpClient;
        unsafe {
            drop(Box::from_raw(handle as *mut SrpClient));
        }
    }
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeSrpClientGenerateSalt<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    handle: jlong,
) -> JString<'a> {
    if handle == 0 {
        return JString::default();
    }

    use bittery_crypto_core::srp6a::SrpClient;
    let client = unsafe { &*(handle as *const SrpClient) };
    new_string(&mut env, &client.generate_salt())
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeSrpClientDeriveSafePrivateKey<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    handle: jlong,
    salt: JString<'a>,
    password: JString<'a>,
    iterations: jint,
) -> JString<'a> {
    if handle == 0 {
        return JString::default();
    }

    let salt_str = match get_string(&mut env, salt) {
        Some(s) => s,
        None => return JString::default(),
    };
    let password_str = match get_secret_string(&mut env, password) {
        Some(s) => s,
        None => return JString::default(),
    };

    use bittery_crypto_core::srp6a::SrpClient;
    let client = unsafe { &*(handle as *const SrpClient) };

    let iterations_opt = if iterations > 0 {
        Some(iterations as u32)
    } else {
        None
    };
    match client.derive_safe_private_key(&salt_str, &password_str, iterations_opt) {
        Ok(mut private_key) => {
            let result = new_string(&mut env, &private_key);
            private_key.zeroize();
            result
        }
        Err(_) => JString::default(),
    }
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeSrpClientDeriveVerifier<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    handle: jlong,
    private_key: JString<'a>,
) -> JString<'a> {
    if handle == 0 {
        return JString::default();
    }

    let pk = match get_secret_string(&mut env, private_key) {
        Some(s) => s,
        None => return JString::default(),
    };

    use bittery_crypto_core::srp6a::SrpClient;
    let client = unsafe { &*(handle as *const SrpClient) };
    // The verifier is password-equivalent, so it is treated as secret material.
    match client.derive_verifier(&pk) {
        Ok(mut verifier) => {
            let result = new_string(&mut env, &verifier);
            verifier.zeroize();
            result
        }
        Err(_) => JString::default(),
    }
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeSrpClientGenerateEphemeral<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    handle: jlong,
) -> JObject<'a> {
    if handle == 0 {
        return create_ephemeral_result(&mut env, "", "");
    }

    use bittery_crypto_core::srp6a::SrpClient;
    let client = unsafe { &*(handle as *const SrpClient) };
    // `Ephemeral` is `ZeroizeOnDrop` in the core, so the secret ephemeral is
    // wiped when it drops at the end of this function.
    let ephemeral = client.generate_ephemeral();
    create_ephemeral_result(&mut env, &ephemeral.public, &ephemeral.secret)
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeSrpClientDeriveSession<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    handle: jlong,
    client_secret_ephemeral: JString<'a>,
    server_public_ephemeral: JString<'a>,
    salt: JString<'a>,
    username: JString<'a>,
    private_key: JString<'a>,
) -> JObject<'a> {
    if handle == 0 {
        return create_session_result(&mut env, None, None, Some("Null handle"));
    }

    let cse = match get_secret_string(&mut env, client_secret_ephemeral) {
        Some(s) => s,
        None => {
            return create_session_result(
                &mut env,
                None,
                None,
                Some("Invalid client secret ephemeral"),
            )
        }
    };
    let spe = match get_string(&mut env, server_public_ephemeral) {
        Some(s) => s,
        None => {
            return create_session_result(
                &mut env,
                None,
                None,
                Some("Invalid server public ephemeral"),
            )
        }
    };
    let salt_str = match get_string(&mut env, salt) {
        Some(s) => s,
        None => return create_session_result(&mut env, None, None, Some("Invalid salt")),
    };
    let username_str = match get_string(&mut env, username) {
        Some(s) => s,
        None => return create_session_result(&mut env, None, None, Some("Invalid username")),
    };
    let pk = match get_secret_string(&mut env, private_key) {
        Some(s) => s,
        None => return create_session_result(&mut env, None, None, Some("Invalid private key")),
    };

    use bittery_crypto_core::srp6a::SrpClient;
    let client = unsafe { &*(handle as *const SrpClient) };

    // `Session` is `ZeroizeOnDrop` in the core, so the session key is wiped when
    // it drops at the end of this match.
    match client.derive_session(&cse, &spe, &salt_str, &username_str, &pk) {
        Ok(session) => {
            create_session_result(&mut env, Some(&session.key), Some(&session.proof), None)
        }
        Err(e) => create_session_result(&mut env, None, None, Some(&e.to_string())),
    }
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeSrpClientVerifySession<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    handle: jlong,
    client_public_ephemeral: JString<'a>,
    session_key: JString<'a>,
    session_proof: JString<'a>,
    server_session_proof: JString<'a>,
) -> JString<'a> {
    use bittery_crypto_core::srp6a::{Session, SrpClient};

    if handle == 0 {
        return new_string(&mut env, "ERROR:Null handle");
    }

    let cpe = match get_string(&mut env, client_public_ephemeral) {
        Some(s) => s,
        None => return new_string(&mut env, "ERROR:Invalid client public ephemeral"),
    };
    let key = match get_string(&mut env, session_key) {
        Some(s) => s,
        None => return new_string(&mut env, "ERROR:Invalid session key"),
    };
    let proof = match get_string(&mut env, session_proof) {
        Some(s) => s,
        None => return new_string(&mut env, "ERROR:Invalid session proof"),
    };
    let server_proof = match get_string(&mut env, server_session_proof) {
        Some(s) => s,
        None => return new_string(&mut env, "ERROR:Invalid server session proof"),
    };

    let client = unsafe { &*(handle as *const SrpClient) };
    // `Session` is `ZeroizeOnDrop` in the core, so moving the session key into it
    // is what wipes this crate's copy.
    let session = Session { key, proof };

    match client.verify_session(&cpe, &session, &server_proof) {
        Ok(()) => new_string(&mut env, "OK"),
        Err(e) => new_string(&mut env, &format!("ERROR:{}", e)),
    }
}

// ============================================================================
// SRP-6a Server
// ============================================================================

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeSrpServerNew<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    hash_algorithm: JString<'a>,
    prime_group: jint,
) -> jlong {
    let hash_str = match get_string(&mut env, hash_algorithm) {
        Some(s) => s,
        None => return 0,
    };

    use bittery_crypto_core::srp6a::{HashAlgorithm, PrimeGroup, SrpServer};

    let hash = match hash_str.as_str() {
        "SHA-256" => HashAlgorithm::Sha256,
        _ => return 0,
    };

    let group = match prime_group {
        4096 => PrimeGroup::G4096,
        _ => return 0,
    };

    let server = Box::new(SrpServer::new(hash, group));
    Box::into_raw(server) as jlong
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeSrpServerFree<
    'a,
>(
    _env: JNIEnv<'a>,
    _class: JClass<'a>,
    handle: jlong,
) {
    if handle != 0 {
        use bittery_crypto_core::srp6a::SrpServer;
        unsafe {
            drop(Box::from_raw(handle as *mut SrpServer));
        }
    }
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeSrpServerGenerateEphemeral<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    handle: jlong,
    verifier: JString<'a>,
) -> JObject<'a> {
    if handle == 0 {
        return create_ephemeral_result(&mut env, "", "");
    }

    let v = match get_secret_string(&mut env, verifier) {
        Some(s) => s,
        None => return create_ephemeral_result(&mut env, "", ""),
    };

    use bittery_crypto_core::srp6a::SrpServer;
    let server = unsafe { &*(handle as *const SrpServer) };
    match server.generate_ephemeral(&v) {
        Ok(ephemeral) => create_ephemeral_result(&mut env, &ephemeral.public, &ephemeral.secret),
        Err(_) => create_ephemeral_result(&mut env, "", ""),
    }
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeSrpServerDeriveSession<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    handle: jlong,
    server_secret_ephemeral: JString<'a>,
    client_public_ephemeral: JString<'a>,
    salt: JString<'a>,
    username: JString<'a>,
    verifier: JString<'a>,
    client_session_proof: JString<'a>,
) -> JObject<'a> {
    if handle == 0 {
        return create_session_result(&mut env, None, None, Some("Null handle"));
    }

    let sse = match get_secret_string(&mut env, server_secret_ephemeral) {
        Some(s) => s,
        None => {
            return create_session_result(
                &mut env,
                None,
                None,
                Some("Invalid server secret ephemeral"),
            )
        }
    };
    let cpe = match get_string(&mut env, client_public_ephemeral) {
        Some(s) => s,
        None => {
            return create_session_result(
                &mut env,
                None,
                None,
                Some("Invalid client public ephemeral"),
            )
        }
    };
    let salt_str = match get_string(&mut env, salt) {
        Some(s) => s,
        None => return create_session_result(&mut env, None, None, Some("Invalid salt")),
    };
    let username_str = match get_string(&mut env, username) {
        Some(s) => s,
        None => return create_session_result(&mut env, None, None, Some("Invalid username")),
    };
    let v = match get_secret_string(&mut env, verifier) {
        Some(s) => s,
        None => return create_session_result(&mut env, None, None, Some("Invalid verifier")),
    };
    let csp = match get_string(&mut env, client_session_proof) {
        Some(s) => s,
        None => {
            return create_session_result(
                &mut env,
                None,
                None,
                Some("Invalid client session proof"),
            )
        }
    };

    use bittery_crypto_core::srp6a::SrpServer;
    let server = unsafe { &*(handle as *const SrpServer) };

    // `Session` is `ZeroizeOnDrop` in the core, so the session key is wiped when
    // it drops at the end of this match.
    match server.derive_session(&sse, &cpe, &salt_str, &username_str, &v, &csp) {
        Ok(session) => {
            create_session_result(&mut env, Some(&session.key), Some(&session.proof), None)
        }
        Err(e) => create_session_result(&mut env, None, None, Some(&e.to_string())),
    }
}

// ============================================================================
// Passkey / WebAuthn
// ============================================================================

fn create_passkey_keypair_result<'a>(
    env: &mut JNIEnv<'a>,
    private_key: Option<&str>,
    public_key_cose: Option<&str>,
    error: Option<&str>,
) -> JObject<'a> {
    let class = env
        .find_class("expo/modules/bitterycrypto/BitteryCryptoModule$PasskeyKeypairResult")
        .unwrap();

    let private_key_str = private_key.map(|s| new_string(env, s)).unwrap_or_default();
    let public_key_cose_str = public_key_cose
        .map(|s| new_string(env, s))
        .unwrap_or_default();
    let error_str = error.map(|s| new_string(env, s)).unwrap_or_default();

    env.new_object(
        class,
        "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V",
        &[
            JValue::Object(&private_key_str),
            JValue::Object(&public_key_cose_str),
            JValue::Object(&error_str),
        ],
    )
    .unwrap()
}

fn create_passkey_attestation_result<'a>(
    env: &mut JNIEnv<'a>,
    authenticator_data: Option<&str>,
    attestation_object: Option<&str>,
    error: Option<&str>,
) -> JObject<'a> {
    let class = env
        .find_class("expo/modules/bitterycrypto/BitteryCryptoModule$PasskeyAttestationResult")
        .unwrap();

    let authenticator_data_str = authenticator_data
        .map(|s| new_string(env, s))
        .unwrap_or_default();
    let attestation_object_str = attestation_object
        .map(|s| new_string(env, s))
        .unwrap_or_default();
    let error_str = error.map(|s| new_string(env, s)).unwrap_or_default();

    env.new_object(
        class,
        "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V",
        &[
            JValue::Object(&authenticator_data_str),
            JValue::Object(&attestation_object_str),
            JValue::Object(&error_str),
        ],
    )
    .unwrap()
}

fn create_passkey_assertion_result<'a>(
    env: &mut JNIEnv<'a>,
    authenticator_data: Option<&str>,
    signature_der: Option<&str>,
    error: Option<&str>,
) -> JObject<'a> {
    let class = env
        .find_class("expo/modules/bitterycrypto/BitteryCryptoModule$PasskeyAssertionResult")
        .unwrap();

    let authenticator_data_str = authenticator_data
        .map(|s| new_string(env, s))
        .unwrap_or_default();
    let signature_der_str = signature_der
        .map(|s| new_string(env, s))
        .unwrap_or_default();
    let error_str = error.map(|s| new_string(env, s)).unwrap_or_default();

    env.new_object(
        class,
        "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V",
        &[
            JValue::Object(&authenticator_data_str),
            JValue::Object(&signature_der_str),
            JValue::Object(&error_str),
        ],
    )
    .unwrap()
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativePasskeyGenerateKeypair<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
) -> JObject<'a> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use bittery_crypto_core::generate_passkey_keypair;

    // Only `private_key` + `public_key_cose` cross this boundary, matching
    // `bittery_passkey_generate_keypair`'s C ABI shape: `public_key_spki` has no
    // consumer on any adapter today.
    match generate_passkey_keypair() {
        Ok(mut result) => {
            let mut private_key = STANDARD.encode(result.private_key.as_slice());
            result.private_key.zeroize();
            let public_key_cose = STANDARD.encode(&result.public_key_cose);
            let keypair = create_passkey_keypair_result(
                &mut env,
                Some(&private_key),
                Some(&public_key_cose),
                None,
            );
            private_key.zeroize();
            keypair
        }
        Err(e) => create_passkey_keypair_result(&mut env, None, None, Some(&e.to_string())),
    }
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativePasskeyGenerateCredentialId<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
) -> JString<'a> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use bittery_crypto_core::generate_credential_id;
    new_string(&mut env, &STANDARD.encode(generate_credential_id()))
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativePasskeyBuildAttestationObject<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    rp_id: JString<'a>,
    credential_id_base64: JString<'a>,
    cose_public_key_base64: JString<'a>,
    sign_count: jint,
) -> JObject<'a> {
    let rp_id_str = match get_string(&mut env, rp_id) {
        Some(s) => s,
        None => {
            return create_passkey_attestation_result(&mut env, None, None, Some("Invalid rpId"))
        }
    };
    let credential_id_str = match get_string(&mut env, credential_id_base64) {
        Some(s) => s,
        None => {
            return create_passkey_attestation_result(
                &mut env,
                None,
                None,
                Some("Invalid credentialId"),
            )
        }
    };
    let cose_public_key_str = match get_string(&mut env, cose_public_key_base64) {
        Some(s) => s,
        None => {
            return create_passkey_attestation_result(
                &mut env,
                None,
                None,
                Some("Invalid COSE public key"),
            )
        }
    };
    // `jint` is signed: a negative `sign_count` would reinterpret as a huge `u32`
    // if cast blindly, so reject it up front (matches `nativeGenerateTotp`'s
    // `digits`/`period` guards).
    let sign_count = match u32::try_from(sign_count) {
        Ok(v) => v,
        Err(_) => {
            return create_passkey_attestation_result(
                &mut env,
                None,
                None,
                Some("Invalid signCount"),
            )
        }
    };

    use base64::{engine::general_purpose::STANDARD, Engine};
    use bittery_crypto_core::build_passkey_attestation_object;

    let credential_id = match STANDARD.decode(&credential_id_str) {
        Ok(value) => value,
        Err(error) => {
            return create_passkey_attestation_result(
                &mut env,
                None,
                None,
                Some(&format!("Invalid credentialId base64: {}", error)),
            )
        }
    };
    let cose_public_key = match STANDARD.decode(&cose_public_key_str) {
        Ok(value) => value,
        Err(error) => {
            return create_passkey_attestation_result(
                &mut env,
                None,
                None,
                Some(&format!("Invalid COSE key base64: {}", error)),
            )
        }
    };

    match build_passkey_attestation_object(&rp_id_str, &credential_id, &cose_public_key, sign_count)
    {
        Ok(result) => create_passkey_attestation_result(
            &mut env,
            Some(&STANDARD.encode(result.authenticator_data)),
            Some(&STANDARD.encode(result.attestation_object)),
            None,
        ),
        Err(e) => create_passkey_attestation_result(&mut env, None, None, Some(&e.to_string())),
    }
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativePasskeySignAssertion<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    private_key_base64: JString<'a>,
    rp_id: JString<'a>,
    client_data_hash_base64: JString<'a>,
    sign_count: jint,
) -> JObject<'a> {
    let private_key_str = match get_secret_string(&mut env, private_key_base64) {
        Some(s) => s,
        None => {
            return create_passkey_assertion_result(
                &mut env,
                None,
                None,
                Some("Invalid private key"),
            )
        }
    };
    let rp_id_str = match get_string(&mut env, rp_id) {
        Some(s) => s,
        None => return create_passkey_assertion_result(&mut env, None, None, Some("Invalid rpId")),
    };
    let client_data_hash_str = match get_string(&mut env, client_data_hash_base64) {
        Some(s) => s,
        None => {
            return create_passkey_assertion_result(
                &mut env,
                None,
                None,
                Some("Invalid clientDataHash"),
            )
        }
    };
    let sign_count = match u32::try_from(sign_count) {
        Ok(v) => v,
        Err(_) => {
            return create_passkey_assertion_result(&mut env, None, None, Some("Invalid signCount"))
        }
    };

    use base64::{engine::general_purpose::STANDARD, Engine};
    use bittery_crypto_core::sign_passkey_assertion;

    let private_key = match STANDARD.decode(&private_key_str) {
        Ok(value) => Zeroizing::new(value),
        Err(error) => {
            return create_passkey_assertion_result(
                &mut env,
                None,
                None,
                Some(&format!("Invalid private key base64: {}", error)),
            )
        }
    };
    let client_data_hash = match STANDARD.decode(&client_data_hash_str) {
        Ok(value) => value,
        Err(error) => {
            return create_passkey_assertion_result(
                &mut env,
                None,
                None,
                Some(&format!("Invalid clientDataHash base64: {}", error)),
            )
        }
    };

    match sign_passkey_assertion(&private_key, &rp_id_str, &client_data_hash, sign_count) {
        Ok(result) => create_passkey_assertion_result(
            &mut env,
            Some(&STANDARD.encode(result.authenticator_data)),
            Some(&STANDARD.encode(result.signature_der)),
            None,
        ),
        Err(e) => create_passkey_assertion_result(&mut env, None, None, Some(&e.to_string())),
    }
}

// ============================================================================
// Key Rotation
// ============================================================================

fn create_re_encrypted_item_result<'a>(
    env: &mut JNIEnv<'a>,
    item_id: Option<&str>,
    encrypted_data: Option<&str>,
    encryption_iv: Option<&str>,
    error: Option<&str>,
) -> JObject<'a> {
    let class = env
        .find_class("expo/modules/bitterycrypto/BitteryCryptoModule$ReEncryptedItemResult")
        .unwrap();

    let item_id_str = item_id.map(|s| new_string(env, s)).unwrap_or_default();
    let encrypted_data_str = encrypted_data
        .map(|s| new_string(env, s))
        .unwrap_or_default();
    let encryption_iv_str = encryption_iv
        .map(|s| new_string(env, s))
        .unwrap_or_default();
    let error_str = error.map(|s| new_string(env, s)).unwrap_or_default();

    env.new_object(
        class,
        "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V",
        &[
            JValue::Object(&item_id_str),
            JValue::Object(&encrypted_data_str),
            JValue::Object(&encryption_iv_str),
            JValue::Object(&error_str),
        ],
    )
    .unwrap()
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeEncryptVaultKeyForMember<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    vault_key_base64: JString<'a>,
    member_public_key_pem: JString<'a>,
) -> JString<'a> {
    let vault_key_str = match get_secret_string(&mut env, vault_key_base64) {
        Some(s) => s,
        None => return new_string(&mut env, "ERROR:Invalid vault key"),
    };
    let public_key_str = match get_string(&mut env, member_public_key_pem) {
        Some(s) => s,
        None => return new_string(&mut env, "ERROR:Invalid public key"),
    };

    use base64::{engine::general_purpose::STANDARD, Engine};
    use bittery_crypto_core::encrypt_vault_key_for_member;

    let vault_key = match STANDARD.decode(&vault_key_str) {
        Ok(k) => Zeroizing::new(k),
        Err(e) => return new_string(&mut env, &format!("ERROR:Invalid vault key base64: {}", e)),
    };

    match encrypt_vault_key_for_member(&vault_key, &public_key_str) {
        Ok(encrypted) => new_string(&mut env, &encrypted),
        Err(e) => new_string(&mut env, &format!("ERROR:{}", e)),
    }
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeEncryptVaultKeyWithMuk<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    vault_key_base64: JString<'a>,
    master_unlock_key_base64: JString<'a>,
    vault_id: JString<'a>,
    user_id: JString<'a>,
    key_version: jlong,
) -> JString<'a> {
    let vault_key_str = match get_secret_string(&mut env, vault_key_base64) {
        Some(s) => s,
        None => return new_string(&mut env, "ERROR:Invalid vault key"),
    };
    let muk_str = match get_secret_string(&mut env, master_unlock_key_base64) {
        Some(s) => s,
        None => return new_string(&mut env, "ERROR:Invalid master unlock key"),
    };
    let vault_id_str = match get_string(&mut env, vault_id) {
        Some(s) => s,
        None => return new_string(&mut env, "ERROR:Invalid vault ID"),
    };
    let user_id_str = match get_string(&mut env, user_id) {
        Some(s) => s,
        None => return new_string(&mut env, "ERROR:Invalid user ID"),
    };

    use base64::{engine::general_purpose::STANDARD, Engine};
    use bittery_crypto_core::{encrypt_vault_key_with_muk, VaultKeyWrapContext};

    let vault_key = match STANDARD.decode(&vault_key_str) {
        Ok(k) => Zeroizing::new(k),
        Err(e) => return new_string(&mut env, &format!("ERROR:Invalid vault key base64: {}", e)),
    };
    let muk = match STANDARD.decode(&muk_str) {
        Ok(k) => Zeroizing::new(k),
        Err(e) => return new_string(&mut env, &format!("ERROR:Invalid MUK base64: {}", e)),
    };

    let context = VaultKeyWrapContext::new(&vault_id_str, &user_id_str, key_version as u64);
    match encrypt_vault_key_with_muk(&vault_key, &muk, &context) {
        Ok(encrypted) => new_string(&mut env, &encrypted),
        Err(e) => new_string(&mut env, &format!("ERROR:{}", e)),
    }
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeReEncryptItem<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    item_id: JString<'a>,
    encrypted_data: JString<'a>,
    encryption_iv: JString<'a>,
    encryption_algorithm: JString<'a>,
    old_vault_key_base64: JString<'a>,
    new_vault_key_base64: JString<'a>,
) -> JObject<'a> {
    let id = match get_string(&mut env, item_id) {
        Some(s) => s,
        None => {
            return create_re_encrypted_item_result(
                &mut env,
                None,
                None,
                None,
                Some("Invalid item ID"),
            )
        }
    };
    let enc_data = match get_string(&mut env, encrypted_data) {
        Some(s) => s,
        None => {
            return create_re_encrypted_item_result(
                &mut env,
                None,
                None,
                None,
                Some("Invalid encrypted data"),
            )
        }
    };
    let enc_iv = match get_string(&mut env, encryption_iv) {
        Some(s) => s,
        None => {
            return create_re_encrypted_item_result(
                &mut env,
                None,
                None,
                None,
                Some("Invalid encryption IV"),
            )
        }
    };
    let enc_algo = match get_string(&mut env, encryption_algorithm) {
        Some(s) => s,
        None => {
            return create_re_encrypted_item_result(
                &mut env,
                None,
                None,
                None,
                Some("Invalid encryption algorithm"),
            )
        }
    };
    let old_key_str = match get_secret_string(&mut env, old_vault_key_base64) {
        Some(s) => s,
        None => {
            return create_re_encrypted_item_result(
                &mut env,
                None,
                None,
                None,
                Some("Invalid old vault key"),
            )
        }
    };
    let new_key_str = match get_secret_string(&mut env, new_vault_key_base64) {
        Some(s) => s,
        None => {
            return create_re_encrypted_item_result(
                &mut env,
                None,
                None,
                None,
                Some("Invalid new vault key"),
            )
        }
    };

    use base64::{engine::general_purpose::STANDARD, Engine};
    use bittery_crypto_core::{re_encrypt_item, ItemData};

    let old_key = match STANDARD.decode(&old_key_str) {
        Ok(k) => Zeroizing::new(k),
        Err(e) => {
            return create_re_encrypted_item_result(
                &mut env,
                None,
                None,
                None,
                Some(&format!("Invalid old key base64: {}", e)),
            )
        }
    };
    let new_key = match STANDARD.decode(&new_key_str) {
        Ok(k) => Zeroizing::new(k),
        Err(e) => {
            return create_re_encrypted_item_result(
                &mut env,
                None,
                None,
                None,
                Some(&format!("Invalid new key base64: {}", e)),
            )
        }
    };

    let item = ItemData {
        id,
        encrypted_data: enc_data,
        encryption_iv: enc_iv,
        encryption_algorithm: enc_algo,
    };

    match re_encrypt_item(&item, &old_key, &new_key) {
        Ok(result) => create_re_encrypted_item_result(
            &mut env,
            Some(&result.item_id),
            Some(&result.encrypted_data),
            Some(&result.encryption_iv),
            None,
        ),
        Err(e) => create_re_encrypted_item_result(&mut env, None, None, None, Some(&e.to_string())),
    }
}

fn create_key_rotation_result<'a>(
    env: &mut JNIEnv<'a>,
    member_encrypted_keys_json: Option<&str>,
    re_encrypted_items_json: Option<&str>,
    error: Option<&str>,
) -> JObject<'a> {
    let class = env
        .find_class("expo/modules/bitterycrypto/BitteryCryptoModule$KeyRotationResult")
        .unwrap();

    let member_keys_str = member_encrypted_keys_json
        .map(|s| new_string(env, s))
        .unwrap_or_default();
    let items_str = re_encrypted_items_json
        .map(|s| new_string(env, s))
        .unwrap_or_default();
    let error_str = error.map(|s| new_string(env, s)).unwrap_or_default();

    env.new_object(
        class,
        "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V",
        &[
            JValue::Object(&member_keys_str),
            JValue::Object(&items_str),
            JValue::Object(&error_str),
        ],
    )
    .unwrap()
}

/// Unlike every other result struct in this file, `ValidationResultFFI` has no
/// `error` field: malformed `members_json` is reported as `{valid: false,
/// errors: [...]}`, not a hard failure, matching the core's own design.
fn create_validation_result<'a>(
    env: &mut JNIEnv<'a>,
    valid: bool,
    errors_json: &str,
) -> JObject<'a> {
    let class = env
        .find_class("expo/modules/bitterycrypto/BitteryCryptoModule$ValidationResult")
        .unwrap();

    let errors_str = new_string(env, errors_json);
    let valid_flag: jboolean = if valid { JNI_TRUE } else { JNI_FALSE };

    env.new_object(
        class,
        "(ZLjava/lang/String;)V",
        &[JValue::Bool(valid_flag), JValue::Object(&errors_str)],
    )
    .unwrap()
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativePerformKeyRotation<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    old_vault_key_base64: JString<'a>,
    members_json: JString<'a>,
    items_json: JString<'a>,
    vault_id: JString<'a>,
    key_version: jlong,
    current_user_id: JString<'a>,
    master_unlock_key_base64: JString<'a>,
) -> JObject<'a> {
    let old_key_str = match get_secret_string(&mut env, old_vault_key_base64) {
        Some(s) => s,
        None => {
            return create_key_rotation_result(&mut env, None, None, Some("Invalid old vault key"))
        }
    };
    let members_str = match get_string(&mut env, members_json) {
        Some(s) => s,
        None => {
            return create_key_rotation_result(&mut env, None, None, Some("Invalid members JSON"))
        }
    };
    let items_str = match get_string(&mut env, items_json) {
        Some(s) => s,
        None => {
            return create_key_rotation_result(&mut env, None, None, Some("Invalid items JSON"))
        }
    };
    let vault_id_str = match get_string(&mut env, vault_id) {
        Some(s) => s,
        None => return create_key_rotation_result(&mut env, None, None, Some("Invalid vault ID")),
    };
    let user_id_str = match get_string(&mut env, current_user_id) {
        Some(s) => s,
        None => {
            return create_key_rotation_result(
                &mut env,
                None,
                None,
                Some("Invalid current user ID"),
            )
        }
    };
    let muk_str = match get_secret_string(&mut env, master_unlock_key_base64) {
        Some(s) => s,
        None => {
            return create_key_rotation_result(
                &mut env,
                None,
                None,
                Some("Invalid master unlock key"),
            )
        }
    };

    use base64::{engine::general_purpose::STANDARD, Engine};
    use bittery_crypto_core::{perform_key_rotation, ItemData, MemberKeyData};

    let old_key = match STANDARD.decode(&old_key_str) {
        Ok(k) => Zeroizing::new(k),
        Err(e) => {
            return create_key_rotation_result(
                &mut env,
                None,
                None,
                Some(&format!("Invalid old key base64: {}", e)),
            )
        }
    };
    let muk = match STANDARD.decode(&muk_str) {
        Ok(k) => Zeroizing::new(k),
        Err(e) => {
            return create_key_rotation_result(
                &mut env,
                None,
                None,
                Some(&format!("Invalid MUK base64: {}", e)),
            )
        }
    };

    let members: Vec<MemberKeyData> = match serde_json::from_str(&members_str) {
        Ok(m) => m,
        Err(e) => {
            return create_key_rotation_result(
                &mut env,
                None,
                None,
                Some(&format!("Invalid members JSON: {}", e)),
            )
        }
    };
    let items: Vec<ItemData> = match serde_json::from_str(&items_str) {
        Ok(i) => i,
        Err(e) => {
            return create_key_rotation_result(
                &mut env,
                None,
                None,
                Some(&format!("Invalid items JSON: {}", e)),
            )
        }
    };

    match perform_key_rotation(
        &old_key,
        &members,
        &items,
        &vault_id_str,
        key_version as u64,
        &user_id_str,
        &muk,
    ) {
        Ok(result) => {
            let member_keys_json = serde_json::to_string(&result.member_encrypted_keys)
                .unwrap_or_else(|_| "[]".to_string());
            let items_json_out = serde_json::to_string(&result.re_encrypted_items)
                .unwrap_or_else(|_| "[]".to_string());
            create_key_rotation_result(
                &mut env,
                Some(&member_keys_json),
                Some(&items_json_out),
                None,
            )
        }
        Err(e) => create_key_rotation_result(&mut env, None, None, Some(&e.to_string())),
    }
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeValidateRotationData<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    members_json: JString<'a>,
) -> JObject<'a> {
    let members_str = match get_string(&mut env, members_json) {
        Some(s) => s,
        None => return create_validation_result(&mut env, false, "[\"Invalid members JSON\"]"),
    };

    use bittery_crypto_core::{validate_rotation_data, MemberKeyData};

    let members: Vec<MemberKeyData> = match serde_json::from_str(&members_str) {
        Ok(m) => m,
        Err(e) => return create_validation_result(&mut env, false, &format!("[\"{}\"]", e)),
    };

    let result = validate_rotation_data(&members);
    let errors_json = serde_json::to_string(&result.errors).unwrap_or_else(|_| "[]".to_string());
    create_validation_result(&mut env, result.valid, &errors_json)
}

// ============================================================================
// Credential Provider JNI Bindings
// ============================================================================
// These are separate entry points for the credential-provider module which uses
// a different Java package (expo.modules.credentialprovider.crypto.NativeCrypto)

/// Helper to create a simple string result object for credential provider
fn create_cp_result<'a>(
    env: &mut JNIEnv<'a>,
    value: Option<&str>,
    error: Option<&str>,
) -> JObject<'a> {
    let class = env
        .find_class("expo/modules/credentialprovider/crypto/NativeCrypto$Result")
        .unwrap();

    let value_str = value.map(|s| new_string(env, s)).unwrap_or_default();
    let error_str = error.map(|s| new_string(env, s)).unwrap_or_default();

    env.new_object(
        class,
        "(Ljava/lang/String;Ljava/lang/String;)V",
        &[JValue::Object(&value_str), JValue::Object(&error_str)],
    )
    .unwrap()
}

/// Helper to create derived keys result for credential provider
fn create_cp_derived_keys_result<'a>(
    env: &mut JNIEnv<'a>,
    auth_key: Option<&str>,
    master_unlock_key: Option<&str>,
    error: Option<&str>,
) -> JObject<'a> {
    let class = env
        .find_class("expo/modules/credentialprovider/crypto/NativeCrypto$DerivedKeysResult")
        .unwrap();

    let auth_key_str = auth_key.map(|s| new_string(env, s)).unwrap_or_default();
    let muk_str = master_unlock_key
        .map(|s| new_string(env, s))
        .unwrap_or_default();
    let error_str = error.map(|s| new_string(env, s)).unwrap_or_default();

    env.new_object(
        class,
        "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V",
        &[
            JValue::Object(&auth_key_str),
            JValue::Object(&muk_str),
            JValue::Object(&error_str),
        ],
    )
    .unwrap()
}

/// Helper to create encrypt result for credential provider
fn create_cp_encrypt_result<'a>(
    env: &mut JNIEnv<'a>,
    ciphertext: Option<&str>,
    iv: Option<&str>,
    algorithm: Option<&str>,
    error: Option<&str>,
) -> JObject<'a> {
    let class = env
        .find_class("expo/modules/credentialprovider/crypto/NativeCrypto$EncryptResult")
        .unwrap();

    let ct_str = ciphertext.map(|s| new_string(env, s)).unwrap_or_default();
    let iv_str = iv.map(|s| new_string(env, s)).unwrap_or_default();
    let alg_str = algorithm.map(|s| new_string(env, s)).unwrap_or_default();
    let error_str = error.map(|s| new_string(env, s)).unwrap_or_default();

    env.new_object(
        class,
        "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V",
        &[
            JValue::Object(&ct_str),
            JValue::Object(&iv_str),
            JValue::Object(&alg_str),
            JValue::Object(&error_str),
        ],
    )
    .unwrap()
}

// ----------------------------------------------------------------------------
// Key Derivation for Credential Provider
// ----------------------------------------------------------------------------

#[no_mangle]
pub extern "system" fn Java_expo_modules_credentialprovider_crypto_NativeCrypto_nativeDeriveKeys<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    password: JString<'a>,
    secret_key: JString<'a>,
    email: JString<'a>,
    schema_version: jint,
    algorithm: JString<'a>,
    iterations: jint,
) -> JObject<'a> {
    let password_str = match get_secret_string(&mut env, password) {
        Some(s) => s,
        None => {
            return create_cp_derived_keys_result(&mut env, None, None, Some("Invalid password"))
        }
    };
    let secret_str = match get_secret_string(&mut env, secret_key) {
        Some(s) => s,
        None => {
            return create_cp_derived_keys_result(&mut env, None, None, Some("Invalid secret key"))
        }
    };
    let email_str = match get_string(&mut env, email) {
        Some(s) => s,
        None => return create_cp_derived_keys_result(&mut env, None, None, Some("Invalid email")),
    };

    use base64::{engine::general_purpose::STANDARD, Engine};
    use bittery_crypto_core::{derive_keys, KdfProfile};
    let algorithm = match get_string(&mut env, algorithm) {
        Some(value) => value,
        None => {
            return create_cp_derived_keys_result(
                &mut env,
                None,
                None,
                Some("Invalid KDF algorithm"),
            )
        }
    };
    if schema_version != 1 || !(600_000..=1_200_000).contains(&iterations) {
        return create_cp_derived_keys_result(&mut env, None, None, Some("Invalid KDF profile"));
    }
    let schema_version = schema_version as u32;
    let iterations = iterations as u32;
    let profile = KdfProfile {
        schema_version,
        algorithm,
        iterations,
    };
    match derive_keys(&password_str, &secret_str, &email_str, &profile) {
        Ok(keys) => {
            let mut auth_key = STANDARD.encode(&keys.auth_key);
            let mut muk = STANDARD.encode(&keys.master_unlock_key);
            let result = create_cp_derived_keys_result(&mut env, Some(&auth_key), Some(&muk), None);
            auth_key.zeroize();
            muk.zeroize();
            result
        }
        Err(e) => create_cp_derived_keys_result(&mut env, None, None, Some(&e.to_string())),
    }
}

// ----------------------------------------------------------------------------
// AES-256-GCM Encryption for Credential Provider
// ----------------------------------------------------------------------------

#[no_mangle]
pub extern "system" fn Java_expo_modules_credentialprovider_crypto_NativeCrypto_nativeEncrypt<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    plaintext: JString<'a>,
    key_base64: JString<'a>,
) -> JObject<'a> {
    let plaintext_str = match get_secret_string(&mut env, plaintext) {
        Some(s) => s,
        None => {
            return create_cp_encrypt_result(&mut env, None, None, None, Some("Invalid plaintext"))
        }
    };
    let key_str = match get_secret_string(&mut env, key_base64) {
        Some(s) => s,
        None => return create_cp_encrypt_result(&mut env, None, None, None, Some("Invalid key")),
    };

    use base64::{engine::general_purpose::STANDARD, Engine};
    use bittery_crypto_core::encrypt;

    let key = match STANDARD.decode(&key_str) {
        Ok(k) => Zeroizing::new(k),
        Err(e) => {
            return create_cp_encrypt_result(
                &mut env,
                None,
                None,
                None,
                Some(&format!("Invalid key base64: {}", e)),
            )
        }
    };

    match encrypt(&plaintext_str, &key) {
        Ok(encrypted) => create_cp_encrypt_result(
            &mut env,
            Some(&encrypted.ciphertext),
            Some(&encrypted.iv),
            Some(&encrypted.algorithm),
            None,
        ),
        Err(e) => create_cp_encrypt_result(&mut env, None, None, None, Some(&e.to_string())),
    }
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_credentialprovider_crypto_NativeCrypto_nativeEncryptWithContext<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    plaintext: JString<'a>,
    key_base64: JString<'a>,
    vault_id: JString<'a>,
    entity_id: JString<'a>,
    entity_type: JString<'a>,
    version: jlong,
    user_id: JString<'a>,
) -> JObject<'a> {
    let plaintext_str = match get_secret_string(&mut env, plaintext) {
        Some(s) => s,
        None => {
            return create_cp_encrypt_result(&mut env, None, None, None, Some("Invalid plaintext"))
        }
    };
    let key_str = match get_secret_string(&mut env, key_base64) {
        Some(s) => s,
        None => return create_cp_encrypt_result(&mut env, None, None, None, Some("Invalid key")),
    };
    let vault_id_str = match get_string(&mut env, vault_id) {
        Some(s) => s,
        None => {
            return create_cp_encrypt_result(&mut env, None, None, None, Some("Invalid vault_id"))
        }
    };
    let entity_id_str = match get_string(&mut env, entity_id) {
        Some(s) => s,
        None => {
            return create_cp_encrypt_result(&mut env, None, None, None, Some("Invalid entity_id"))
        }
    };
    let entity_type_str = match get_string(&mut env, entity_type) {
        Some(s) => s,
        None => {
            return create_cp_encrypt_result(
                &mut env,
                None,
                None,
                None,
                Some("Invalid entity_type"),
            )
        }
    };
    let user_id_str = match get_string(&mut env, user_id) {
        Some(s) => s,
        None => {
            return create_cp_encrypt_result(&mut env, None, None, None, Some("Invalid user_id"))
        }
    };

    use base64::{engine::general_purpose::STANDARD, Engine};
    use bittery_crypto_core::{encrypt_with_aad, AadContext};

    let key = match STANDARD.decode(&key_str) {
        Ok(k) => Zeroizing::new(k),
        Err(e) => {
            return create_cp_encrypt_result(
                &mut env,
                None,
                None,
                None,
                Some(&format!("Invalid key base64: {}", e)),
            )
        }
    };

    let context = AadContext {
        vault_id: vault_id_str,
        entity_id: entity_id_str,
        entity_type: entity_type_str,
        version: version as u64,
        user_id: user_id_str,
    };

    match encrypt_with_aad(&plaintext_str, &key, &context) {
        Ok(encrypted) => create_cp_encrypt_result(
            &mut env,
            Some(&encrypted.ciphertext),
            Some(&encrypted.iv),
            Some(&encrypted.algorithm),
            None,
        ),
        Err(e) => create_cp_encrypt_result(&mut env, None, None, None, Some(&e.to_string())),
    }
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_credentialprovider_crypto_NativeCrypto_nativeDecrypt<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    ciphertext: JString<'a>,
    iv: JString<'a>,
    algorithm: JString<'a>,
    key_base64: JString<'a>,
) -> JObject<'a> {
    let ciphertext_str = match get_string(&mut env, ciphertext) {
        Some(s) => s,
        None => return create_cp_result(&mut env, None, Some("Invalid ciphertext")),
    };
    let iv_str = match get_string(&mut env, iv) {
        Some(s) => s,
        None => return create_cp_result(&mut env, None, Some("Invalid IV")),
    };
    let algorithm_str = match get_string(&mut env, algorithm) {
        Some(s) => s,
        None => return create_cp_result(&mut env, None, Some("Invalid algorithm")),
    };
    let key_str = match get_secret_string(&mut env, key_base64) {
        Some(s) => s,
        None => return create_cp_result(&mut env, None, Some("Invalid key")),
    };

    use base64::{engine::general_purpose::STANDARD, Engine};
    use bittery_crypto_core::{decrypt, EncryptedData};

    let key = match STANDARD.decode(&key_str) {
        Ok(k) => Zeroizing::new(k),
        Err(e) => {
            return create_cp_result(&mut env, None, Some(&format!("Invalid key base64: {}", e)))
        }
    };

    let data = EncryptedData {
        ciphertext: ciphertext_str,
        iv: iv_str,
        algorithm: algorithm_str,
    };

    match decrypt(&data, &key) {
        Ok(mut plaintext) => {
            let result = create_cp_result(&mut env, Some(&plaintext), None);
            plaintext.zeroize();
            result
        }
        Err(e) => create_cp_result(&mut env, None, Some(&e.to_string())),
    }
}

// ----------------------------------------------------------------------------
// RSA for Credential Provider
// ----------------------------------------------------------------------------

#[no_mangle]
pub extern "system" fn Java_expo_modules_credentialprovider_crypto_NativeCrypto_nativeRsaEncrypt<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    plaintext: JString<'a>,
    public_key_pem: JString<'a>,
) -> JObject<'a> {
    let plaintext_str = match get_secret_string(&mut env, plaintext) {
        Some(s) => s,
        None => return create_cp_result(&mut env, None, Some("Invalid plaintext")),
    };
    let pem = match get_string(&mut env, public_key_pem) {
        Some(s) => s,
        None => return create_cp_result(&mut env, None, Some("Invalid public key")),
    };

    use bittery_crypto_core::rsa_encrypt;

    match rsa_encrypt(&plaintext_str, &pem) {
        Ok(ciphertext) => create_cp_result(&mut env, Some(&ciphertext), None),
        Err(e) => create_cp_result(&mut env, None, Some(&e.to_string())),
    }
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_credentialprovider_crypto_NativeCrypto_nativeRsaDecrypt<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    ciphertext: JString<'a>,
    private_key_pem: JString<'a>,
) -> JObject<'a> {
    let ciphertext_str = match get_string(&mut env, ciphertext) {
        Some(s) => s,
        None => return create_cp_result(&mut env, None, Some("Invalid ciphertext")),
    };
    let pem = match get_secret_string(&mut env, private_key_pem) {
        Some(s) => s,
        None => return create_cp_result(&mut env, None, Some("Invalid private key")),
    };

    use bittery_crypto_core::rsa_decrypt;

    match rsa_decrypt(&ciphertext_str, &pem) {
        Ok(mut plaintext) => {
            let result = create_cp_result(&mut env, Some(&plaintext), None);
            plaintext.zeroize();
            result
        }
        Err(e) => create_cp_result(&mut env, None, Some(&e.to_string())),
    }
}

// ----------------------------------------------------------------------------
// Passkey for Credential Provider (future Android flow)
// ----------------------------------------------------------------------------

#[no_mangle]
pub extern "system" fn Java_expo_modules_credentialprovider_crypto_NativeCrypto_nativePasskeyGenerateKeypair<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
) -> JObject<'a> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use bittery_crypto_core::generate_passkey_keypair;

    match generate_passkey_keypair() {
        // `PasskeyKeypair` is `ZeroizeOnDrop`, so the scalar is wiped when
        // `result` goes out of scope; the JSON blob carrying it is not, so it
        // is wiped explicitly below. The extra `private_key` wipe stays as
        // defence in depth.
        Ok(mut result) => {
            let mut value = serde_json::json!({
                "privateKey": STANDARD.encode(result.private_key),
                "publicKeyCose": STANDARD.encode(&result.public_key_cose),
                "publicKeySpki": STANDARD.encode(&result.public_key_spki),
            })
            .to_string();
            result.private_key.zeroize();
            let cp_result = create_cp_result(&mut env, Some(&value), None);
            value.zeroize();
            cp_result
        }
        Err(e) => create_cp_result(&mut env, None, Some(&e.to_string())),
    }
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_credentialprovider_crypto_NativeCrypto_nativePasskeyGenerateCredentialId<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
) -> JObject<'a> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use bittery_crypto_core::generate_credential_id;

    let value = STANDARD.encode(generate_credential_id());
    create_cp_result(&mut env, Some(&value), None)
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_credentialprovider_crypto_NativeCrypto_nativePasskeyBuildAttestationObject<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    rp_id: JString<'a>,
    credential_id_base64: JString<'a>,
    cose_public_key_base64: JString<'a>,
    sign_count: jint,
) -> JObject<'a> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use bittery_crypto_core::build_passkey_attestation_object;

    let rp_id_str = match get_string(&mut env, rp_id) {
        Some(s) => s,
        None => return create_cp_result(&mut env, None, Some("Invalid rpId")),
    };
    let credential_id_str = match get_string(&mut env, credential_id_base64) {
        Some(s) => s,
        None => return create_cp_result(&mut env, None, Some("Invalid credentialId")),
    };
    let cose_public_key_str = match get_string(&mut env, cose_public_key_base64) {
        Some(s) => s,
        None => return create_cp_result(&mut env, None, Some("Invalid COSE public key")),
    };

    let credential_id = match STANDARD.decode(&credential_id_str) {
        Ok(value) => value,
        Err(error) => {
            return create_cp_result(
                &mut env,
                None,
                Some(&format!("Invalid credentialId base64: {}", error)),
            )
        }
    };
    let cose_public_key = match STANDARD.decode(&cose_public_key_str) {
        Ok(value) => value,
        Err(error) => {
            return create_cp_result(
                &mut env,
                None,
                Some(&format!("Invalid COSE key base64: {}", error)),
            )
        }
    };

    match build_passkey_attestation_object(
        &rp_id_str,
        &credential_id,
        &cose_public_key,
        sign_count as u32,
    ) {
        Ok(result) => {
            let value = serde_json::json!({
                "authenticatorData": STANDARD.encode(result.authenticator_data),
                "attestationObject": STANDARD.encode(result.attestation_object),
            })
            .to_string();
            create_cp_result(&mut env, Some(&value), None)
        }
        Err(e) => create_cp_result(&mut env, None, Some(&e.to_string())),
    }
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_credentialprovider_crypto_NativeCrypto_nativePasskeySignAssertion<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    private_key_base64: JString<'a>,
    rp_id: JString<'a>,
    client_data_hash_base64: JString<'a>,
    sign_count: jint,
) -> JObject<'a> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use bittery_crypto_core::sign_passkey_assertion;

    let private_key_str = match get_secret_string(&mut env, private_key_base64) {
        Some(s) => s,
        None => return create_cp_result(&mut env, None, Some("Invalid private key")),
    };
    let rp_id_str = match get_string(&mut env, rp_id) {
        Some(s) => s,
        None => return create_cp_result(&mut env, None, Some("Invalid rpId")),
    };
    let client_data_hash_str = match get_string(&mut env, client_data_hash_base64) {
        Some(s) => s,
        None => return create_cp_result(&mut env, None, Some("Invalid clientDataHash")),
    };

    let private_key = match STANDARD.decode(&private_key_str) {
        Ok(value) => Zeroizing::new(value),
        Err(error) => {
            return create_cp_result(
                &mut env,
                None,
                Some(&format!("Invalid private key base64: {}", error)),
            )
        }
    };
    let client_data_hash = match STANDARD.decode(&client_data_hash_str) {
        Ok(value) => value,
        Err(error) => {
            return create_cp_result(
                &mut env,
                None,
                Some(&format!("Invalid clientDataHash base64: {}", error)),
            )
        }
    };

    match sign_passkey_assertion(
        &private_key,
        &rp_id_str,
        &client_data_hash,
        sign_count as u32,
    ) {
        Ok(result) => {
            let value = serde_json::json!({
                "authenticatorData": STANDARD.encode(result.authenticator_data),
                "signatureDer": STANDARD.encode(result.signature_der),
            })
            .to_string();
            create_cp_result(&mut env, Some(&value), None)
        }
        Err(e) => create_cp_result(&mut env, None, Some(&e.to_string())),
    }
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_credentialprovider_crypto_NativeCrypto_nativeDecryptWithContext<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    ciphertext: JString<'a>,
    iv: JString<'a>,
    algorithm: JString<'a>,
    key_base64: JString<'a>,
    vault_id: JString<'a>,
    entity_id: JString<'a>,
    entity_type: JString<'a>,
    version: jlong,
    user_id: JString<'a>,
) -> JObject<'a> {
    let ciphertext_str = match get_string(&mut env, ciphertext) {
        Some(s) => s,
        None => return create_cp_result(&mut env, None, Some("Invalid ciphertext")),
    };
    let iv_str = match get_string(&mut env, iv) {
        Some(s) => s,
        None => return create_cp_result(&mut env, None, Some("Invalid IV")),
    };
    let algorithm_str = match get_string(&mut env, algorithm) {
        Some(s) => s,
        None => return create_cp_result(&mut env, None, Some("Invalid algorithm")),
    };
    let key_str = match get_secret_string(&mut env, key_base64) {
        Some(s) => s,
        None => return create_cp_result(&mut env, None, Some("Invalid key")),
    };
    let vault_id_str = match get_string(&mut env, vault_id) {
        Some(s) => s,
        None => return create_cp_result(&mut env, None, Some("Invalid vault_id")),
    };
    let entity_id_str = match get_string(&mut env, entity_id) {
        Some(s) => s,
        None => return create_cp_result(&mut env, None, Some("Invalid entity_id")),
    };
    let entity_type_str = match get_string(&mut env, entity_type) {
        Some(s) => s,
        None => return create_cp_result(&mut env, None, Some("Invalid entity_type")),
    };
    let user_id_str = match get_string(&mut env, user_id) {
        Some(s) => s,
        None => return create_cp_result(&mut env, None, Some("Invalid user_id")),
    };

    use base64::{engine::general_purpose::STANDARD, Engine};
    use bittery_crypto_core::{decrypt_with_aad, AadContext, EncryptedData};

    let key = match STANDARD.decode(&key_str) {
        Ok(k) => Zeroizing::new(k),
        Err(e) => {
            return create_cp_result(&mut env, None, Some(&format!("Invalid key base64: {}", e)))
        }
    };

    let data = EncryptedData {
        ciphertext: ciphertext_str,
        iv: iv_str,
        algorithm: algorithm_str,
    };

    let context = AadContext {
        vault_id: vault_id_str,
        entity_id: entity_id_str,
        entity_type: entity_type_str,
        version: version as u64,
        user_id: user_id_str,
    };

    match decrypt_with_aad(&data, &key, &context) {
        Ok(mut plaintext) => {
            let result = create_cp_result(&mut env, Some(&plaintext), None);
            plaintext.zeroize();
            result
        }
        Err(e) => create_cp_result(&mut env, None, Some(&e.to_string())),
    }
}

// ============================================================================
// TOTP (Time-Based One-Time Password)
// ============================================================================

fn create_totp_result<'a>(
    env: &mut JNIEnv<'a>,
    code: Option<&str>,
    remaining_seconds: u64,
    period: u64,
    progress: f64,
    error: Option<&str>,
) -> JObject<'a> {
    let class = env
        .find_class("expo/modules/bitterycrypto/BitteryCryptoModule$TotpResult")
        .unwrap();

    let code_str = code.map(|s| new_string(env, s)).unwrap_or_default();
    let error_str = error.map(|s| new_string(env, s)).unwrap_or_default();

    env.new_object(
        class,
        "(Ljava/lang/String;JJDLjava/lang/String;)V",
        &[
            JValue::Object(&code_str),
            JValue::Long(remaining_seconds as jlong),
            JValue::Long(period as jlong),
            JValue::Double(progress),
            JValue::Object(&error_str),
        ],
    )
    .unwrap()
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeGenerateTotp<
    'a,
>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    secret: JString<'a>,
    algorithm: JString<'a>,
    digits: jint,
    period: jlong,
) -> JObject<'a> {
    let secret_str = match get_secret_string(&mut env, secret) {
        Some(s) => s,
        None => return create_totp_result(&mut env, None, 0, 0, 0.0, Some("Invalid secret")),
    };
    let algorithm_str = match get_string(&mut env, algorithm) {
        Some(s) => s,
        None => return create_totp_result(&mut env, None, 0, 0, 0.0, Some("Invalid algorithm")),
    };

    // `jint`/`jlong` are signed: casting a negative value straight to `u32`/`u64`
    // would reinterpret it as a huge positive number, so reject it up front.
    let digits = match u32::try_from(digits) {
        Ok(d) => d,
        Err(_) => {
            return create_totp_result(&mut env, None, 0, 0, 0.0, Some("Invalid TOTP digits"))
        }
    };
    let period = match u64::try_from(period) {
        Ok(p) => p,
        Err(_) => {
            return create_totp_result(&mut env, None, 0, 0, 0.0, Some("Invalid TOTP period"))
        }
    };

    use bittery_crypto_core::generate_totp;

    match generate_totp(&secret_str, &algorithm_str, digits, period) {
        Ok(mut result) => {
            let totp = create_totp_result(
                &mut env,
                Some(&result.code),
                result.remaining_seconds,
                result.period,
                result.progress,
                None,
            );
            result.code.zeroize();
            totp
        }
        Err(e) => create_totp_result(&mut env, None, 0, 0, 0.0, Some(&e.to_string())),
    }
}
