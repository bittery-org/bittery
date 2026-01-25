//! JNI bindings for Android
//!
//! This module provides JNI-compatible functions that wrap the FFI functions
//! for use with React Native on Android.

#![cfg(target_os = "android")]

use jni::objects::{JClass, JObject, JString, JValue};
use jni::sys::{jboolean, jint, jlong, JNI_TRUE, JNI_FALSE};
use jni::JNIEnv;

use crate::*;

// ============================================================================
// Helper Functions
// ============================================================================

fn get_string(env: &mut JNIEnv, s: JString) -> Option<String> {
    env.get_string(&s).ok().map(|s| s.into())
}

fn new_string<'a>(env: &mut JNIEnv<'a>, s: &str) -> JString<'a> {
    env.new_string(s).unwrap_or_else(|_| JString::default())
}

fn create_derived_keys_result<'a>(
    env: &mut JNIEnv<'a>,
    auth_key: Option<&str>,
    master_unlock_key: Option<&str>,
    error: Option<&str>,
) -> JObject<'a> {
    let class = env.find_class("expo/modules/bitterycrypto/BitteryCryptoModule$DerivedKeysResult").unwrap();

    let auth_key_str = auth_key.map(|s| new_string(env, s)).unwrap_or_default();
    let muk_str = master_unlock_key.map(|s| new_string(env, s)).unwrap_or_default();
    let error_str = error.map(|s| new_string(env, s)).unwrap_or_default();

    env.new_object(
        class,
        "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V",
        &[
            JValue::Object(&auth_key_str),
            JValue::Object(&muk_str),
            JValue::Object(&error_str),
        ],
    ).unwrap()
}

fn create_encrypt_result<'a>(
    env: &mut JNIEnv<'a>,
    ciphertext: Option<&str>,
    iv: Option<&str>,
    algorithm: Option<&str>,
    error: Option<&str>,
) -> JObject<'a> {
    let class = env.find_class("expo/modules/bitterycrypto/BitteryCryptoModule$EncryptResult").unwrap();

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
    ).unwrap()
}

fn create_rsa_keypair_result<'a>(
    env: &mut JNIEnv<'a>,
    public_key: Option<&str>,
    private_key: Option<&str>,
    error: Option<&str>,
) -> JObject<'a> {
    let class = env.find_class("expo/modules/bitterycrypto/BitteryCryptoModule$RsaKeyPairResult").unwrap();

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
    ).unwrap()
}

fn create_ephemeral_result<'a>(
    env: &mut JNIEnv<'a>,
    public: &str,
    secret: &str,
) -> JObject<'a> {
    let class = env.find_class("expo/modules/bitterycrypto/BitteryCryptoModule$EphemeralResult").unwrap();

    let pub_str = new_string(env, public);
    let secret_str = new_string(env, secret);

    env.new_object(
        class,
        "(Ljava/lang/String;Ljava/lang/String;)V",
        &[
            JValue::Object(&pub_str),
            JValue::Object(&secret_str),
        ],
    ).unwrap()
}

fn create_session_result<'a>(
    env: &mut JNIEnv<'a>,
    key: Option<&str>,
    proof: Option<&str>,
    error: Option<&str>,
) -> JObject<'a> {
    let class = env.find_class("expo/modules/bitterycrypto/BitteryCryptoModule$SessionResult").unwrap();

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
    ).unwrap()
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
) -> JObject<'a> {
    let password_str = match get_string(&mut env, password) {
        Some(s) => s,
        None => return create_derived_keys_result(&mut env, None, None, Some("Invalid password")),
    };
    let secret_str = match get_string(&mut env, secret_key) {
        Some(s) => s,
        None => return create_derived_keys_result(&mut env, None, None, Some("Invalid secret key")),
    };
    let email_str = match get_string(&mut env, email) {
        Some(s) => s,
        None => return create_derived_keys_result(&mut env, None, None, Some("Invalid email")),
    };

    use bittery_crypto_core::derive_keys;
    use base64::{engine::general_purpose::STANDARD, Engine};

    match derive_keys(&password_str, &secret_str, &email_str) {
        Ok(keys) => {
            let auth_key = STANDARD.encode(&keys.auth_key);
            let muk = STANDARD.encode(&keys.master_unlock_key);
            create_derived_keys_result(&mut env, Some(&auth_key), Some(&muk), None)
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
    let plaintext_str = match get_string(&mut env, plaintext) {
        Some(s) => s,
        None => return create_encrypt_result(&mut env, None, None, None, Some("Invalid plaintext")),
    };
    let key_str = match get_string(&mut env, key_base64) {
        Some(s) => s,
        None => return create_encrypt_result(&mut env, None, None, None, Some("Invalid key")),
    };

    use bittery_crypto_core::encrypt;
    use base64::{engine::general_purpose::STANDARD, Engine};

    let key = match STANDARD.decode(&key_str) {
        Ok(k) => k,
        Err(e) => return create_encrypt_result(&mut env, None, None, None, Some(&format!("Invalid key base64: {}", e))),
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
    let key_str = match get_string(&mut env, key_base64) {
        Some(s) => s,
        None => return new_string(&mut env, "ERROR:Invalid key"),
    };

    use bittery_crypto_core::{decrypt, EncryptedData};
    use base64::{engine::general_purpose::STANDARD, Engine};

    let key = match STANDARD.decode(&key_str) {
        Ok(k) => k,
        Err(e) => return new_string(&mut env, &format!("ERROR:Invalid key base64: {}", e)),
    };

    let data = EncryptedData {
        ciphertext: ciphertext_str,
        iv: iv_str,
        algorithm: "AES-GCM".to_string(),
    };

    match decrypt(&data, &key) {
        Ok(plaintext) => new_string(&mut env, &plaintext),
        Err(e) => new_string(&mut env, &format!("ERROR:{}", e)),
    }
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeGenerateEncryptionKey<'a>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
) -> JString<'a> {
    use bittery_crypto_core::generate_encryption_key;
    use base64::{engine::general_purpose::STANDARD, Engine};

    let key = generate_encryption_key();
    new_string(&mut env, &STANDARD.encode(&key))
}

// ============================================================================
// RSA-4096
// ============================================================================

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeGenerateRsaKeyPair<'a>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
) -> JObject<'a> {
    use bittery_crypto_core::generate_rsa_key_pair;

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
    let plaintext_str = match get_string(&mut env, plaintext) {
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
    let pem = match get_string(&mut env, private_key_pem) {
        Some(s) => s,
        None => return new_string(&mut env, "ERROR:Invalid private key"),
    };

    use bittery_crypto_core::rsa_decrypt;

    match rsa_decrypt(&ciphertext_str, &pem) {
        Ok(plaintext) => new_string(&mut env, &plaintext),
        Err(e) => new_string(&mut env, &format!("ERROR:{}", e)),
    }
}

// ============================================================================
// Secret Key
// ============================================================================

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeGenerateSecretKey<'a>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
) -> JString<'a> {
    use bittery_crypto_core::generate_secret_key;
    new_string(&mut env, &generate_secret_key())
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeValidateSecretKey<'a>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    secret_key: JString<'a>,
) -> jboolean {
    let key = match get_string(&mut env, secret_key) {
        Some(s) => s,
        None => return JNI_FALSE,
    };

    use bittery_crypto_core::validate_secret_key;

    if validate_secret_key(&key) { JNI_TRUE } else { JNI_FALSE }
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeGetSecretKeyHint<'a>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    secret_key: JString<'a>,
) -> JString<'a> {
    let key = match get_string(&mut env, secret_key) {
        Some(s) => s,
        None => return JString::default(),
    };

    use bittery_crypto_core::get_secret_key_hint;
    new_string(&mut env, &get_secret_key_hint(&key))
}

// ============================================================================
// SRP-6a Client
// ============================================================================

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeSrpClientNew<'a>(
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
        "SHA-1" => HashAlgorithm::Sha1,
        "SHA-256" => HashAlgorithm::Sha256,
        "SHA-384" => HashAlgorithm::Sha384,
        "SHA-512" => HashAlgorithm::Sha512,
        _ => return 0,
    };

    let group = match prime_group {
        1024 => PrimeGroup::G1024,
        1536 => PrimeGroup::G1536,
        2048 => PrimeGroup::G2048,
        3072 => PrimeGroup::G3072,
        4096 => PrimeGroup::G4096,
        6144 => PrimeGroup::G6144,
        8192 => PrimeGroup::G8192,
        _ => return 0,
    };

    let client = Box::new(SrpClient::new(hash, group));
    Box::into_raw(client) as jlong
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeSrpClientFree<'a>(
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
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeSrpClientGenerateSalt<'a>(
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
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeSrpClientDeriveSafePrivateKey<'a>(
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
    let password_str = match get_string(&mut env, password) {
        Some(s) => s,
        None => return JString::default(),
    };

    use bittery_crypto_core::srp6a::SrpClient;
    let client = unsafe { &*(handle as *const SrpClient) };

    let iterations_opt = if iterations > 0 { Some(iterations as u32) } else { None };
    new_string(&mut env, &client.derive_safe_private_key(&salt_str, &password_str, iterations_opt))
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeSrpClientDeriveVerifier<'a>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    handle: jlong,
    private_key: JString<'a>,
) -> JString<'a> {
    if handle == 0 {
        return JString::default();
    }

    let pk = match get_string(&mut env, private_key) {
        Some(s) => s,
        None => return JString::default(),
    };

    use bittery_crypto_core::srp6a::SrpClient;
    let client = unsafe { &*(handle as *const SrpClient) };
    new_string(&mut env, &client.derive_verifier(&pk))
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeSrpClientGenerateEphemeral<'a>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    handle: jlong,
) -> JObject<'a> {
    if handle == 0 {
        return create_ephemeral_result(&mut env, "", "");
    }

    use bittery_crypto_core::srp6a::SrpClient;
    let client = unsafe { &*(handle as *const SrpClient) };
    let ephemeral = client.generate_ephemeral();
    create_ephemeral_result(&mut env, &ephemeral.public, &ephemeral.secret)
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeSrpClientDeriveSession<'a>(
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

    let cse = match get_string(&mut env, client_secret_ephemeral) {
        Some(s) => s,
        None => return create_session_result(&mut env, None, None, Some("Invalid client secret ephemeral")),
    };
    let spe = match get_string(&mut env, server_public_ephemeral) {
        Some(s) => s,
        None => return create_session_result(&mut env, None, None, Some("Invalid server public ephemeral")),
    };
    let salt_str = match get_string(&mut env, salt) {
        Some(s) => s,
        None => return create_session_result(&mut env, None, None, Some("Invalid salt")),
    };
    let username_str = match get_string(&mut env, username) {
        Some(s) => s,
        None => return create_session_result(&mut env, None, None, Some("Invalid username")),
    };
    let pk = match get_string(&mut env, private_key) {
        Some(s) => s,
        None => return create_session_result(&mut env, None, None, Some("Invalid private key")),
    };

    use bittery_crypto_core::srp6a::SrpClient;
    let client = unsafe { &*(handle as *const SrpClient) };

    match client.derive_session(&cse, &spe, &salt_str, &username_str, &pk) {
        Ok(session) => create_session_result(&mut env, Some(&session.key), Some(&session.proof), None),
        Err(e) => create_session_result(&mut env, None, None, Some(&e.to_string())),
    }
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeSrpClientVerifySession<'a>(
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
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeSrpServerNew<'a>(
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
        "SHA-1" => HashAlgorithm::Sha1,
        "SHA-256" => HashAlgorithm::Sha256,
        "SHA-384" => HashAlgorithm::Sha384,
        "SHA-512" => HashAlgorithm::Sha512,
        _ => return 0,
    };

    let group = match prime_group {
        1024 => PrimeGroup::G1024,
        1536 => PrimeGroup::G1536,
        2048 => PrimeGroup::G2048,
        3072 => PrimeGroup::G3072,
        4096 => PrimeGroup::G4096,
        6144 => PrimeGroup::G6144,
        8192 => PrimeGroup::G8192,
        _ => return 0,
    };

    let server = Box::new(SrpServer::new(hash, group));
    Box::into_raw(server) as jlong
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeSrpServerFree<'a>(
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
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeSrpServerGenerateEphemeral<'a>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    handle: jlong,
    verifier: JString<'a>,
) -> JObject<'a> {
    if handle == 0 {
        return create_ephemeral_result(&mut env, "", "");
    }

    let v = match get_string(&mut env, verifier) {
        Some(s) => s,
        None => return create_ephemeral_result(&mut env, "", ""),
    };

    use bittery_crypto_core::srp6a::SrpServer;
    let server = unsafe { &*(handle as *const SrpServer) };
    let ephemeral = server.generate_ephemeral(&v);
    create_ephemeral_result(&mut env, &ephemeral.public, &ephemeral.secret)
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bitterycrypto_BitteryCryptoModule_nativeSrpServerDeriveSession<'a>(
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

    let sse = match get_string(&mut env, server_secret_ephemeral) {
        Some(s) => s,
        None => return create_session_result(&mut env, None, None, Some("Invalid server secret ephemeral")),
    };
    let cpe = match get_string(&mut env, client_public_ephemeral) {
        Some(s) => s,
        None => return create_session_result(&mut env, None, None, Some("Invalid client public ephemeral")),
    };
    let salt_str = match get_string(&mut env, salt) {
        Some(s) => s,
        None => return create_session_result(&mut env, None, None, Some("Invalid salt")),
    };
    let username_str = match get_string(&mut env, username) {
        Some(s) => s,
        None => return create_session_result(&mut env, None, None, Some("Invalid username")),
    };
    let v = match get_string(&mut env, verifier) {
        Some(s) => s,
        None => return create_session_result(&mut env, None, None, Some("Invalid verifier")),
    };
    let csp = match get_string(&mut env, client_session_proof) {
        Some(s) => s,
        None => return create_session_result(&mut env, None, None, Some("Invalid client session proof")),
    };

    use bittery_crypto_core::srp6a::SrpServer;
    let server = unsafe { &*(handle as *const SrpServer) };

    match server.derive_session(&sse, &cpe, &salt_str, &username_str, &v, &csp) {
        Ok(session) => create_session_result(&mut env, Some(&session.key), Some(&session.proof), None),
        Err(e) => create_session_result(&mut env, None, None, Some(&e.to_string())),
    }
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
    let class = env.find_class("expo/modules/credentialprovider/crypto/NativeCrypto$Result").unwrap();

    let value_str = value.map(|s| new_string(env, s)).unwrap_or_default();
    let error_str = error.map(|s| new_string(env, s)).unwrap_or_default();

    env.new_object(
        class,
        "(Ljava/lang/String;Ljava/lang/String;)V",
        &[
            JValue::Object(&value_str),
            JValue::Object(&error_str),
        ],
    ).unwrap()
}

/// Helper to create derived keys result for credential provider
fn create_cp_derived_keys_result<'a>(
    env: &mut JNIEnv<'a>,
    auth_key: Option<&str>,
    master_unlock_key: Option<&str>,
    error: Option<&str>,
) -> JObject<'a> {
    let class = env.find_class("expo/modules/credentialprovider/crypto/NativeCrypto$DerivedKeysResult").unwrap();

    let auth_key_str = auth_key.map(|s| new_string(env, s)).unwrap_or_default();
    let muk_str = master_unlock_key.map(|s| new_string(env, s)).unwrap_or_default();
    let error_str = error.map(|s| new_string(env, s)).unwrap_or_default();

    env.new_object(
        class,
        "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V",
        &[
            JValue::Object(&auth_key_str),
            JValue::Object(&muk_str),
            JValue::Object(&error_str),
        ],
    ).unwrap()
}

/// Helper to create encrypt result for credential provider
fn create_cp_encrypt_result<'a>(
    env: &mut JNIEnv<'a>,
    ciphertext: Option<&str>,
    iv: Option<&str>,
    algorithm: Option<&str>,
    error: Option<&str>,
) -> JObject<'a> {
    let class = env.find_class("expo/modules/credentialprovider/crypto/NativeCrypto$EncryptResult").unwrap();

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
    ).unwrap()
}

// ----------------------------------------------------------------------------
// Key Derivation for Credential Provider
// ----------------------------------------------------------------------------

#[no_mangle]
pub extern "system" fn Java_expo_modules_credentialprovider_crypto_NativeCrypto_nativeDeriveKeys<'a>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    password: JString<'a>,
    secret_key: JString<'a>,
    email: JString<'a>,
) -> JObject<'a> {
    let password_str = match get_string(&mut env, password) {
        Some(s) => s,
        None => return create_cp_derived_keys_result(&mut env, None, None, Some("Invalid password")),
    };
    let secret_str = match get_string(&mut env, secret_key) {
        Some(s) => s,
        None => return create_cp_derived_keys_result(&mut env, None, None, Some("Invalid secret key")),
    };
    let email_str = match get_string(&mut env, email) {
        Some(s) => s,
        None => return create_cp_derived_keys_result(&mut env, None, None, Some("Invalid email")),
    };

    use bittery_crypto_core::derive_keys;
    use base64::{engine::general_purpose::STANDARD, Engine};

    match derive_keys(&password_str, &secret_str, &email_str) {
        Ok(keys) => {
            let auth_key = STANDARD.encode(&keys.auth_key);
            let muk = STANDARD.encode(&keys.master_unlock_key);
            create_cp_derived_keys_result(&mut env, Some(&auth_key), Some(&muk), None)
        }
        Err(e) => create_cp_derived_keys_result(&mut env, None, None, Some(&e.to_string())),
    }
}

// ----------------------------------------------------------------------------
// AES-256-GCM Encryption for Credential Provider
// ----------------------------------------------------------------------------

#[no_mangle]
pub extern "system" fn Java_expo_modules_credentialprovider_crypto_NativeCrypto_nativeEncrypt<'a>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    plaintext: JString<'a>,
    key_base64: JString<'a>,
) -> JObject<'a> {
    let plaintext_str = match get_string(&mut env, plaintext) {
        Some(s) => s,
        None => return create_cp_encrypt_result(&mut env, None, None, None, Some("Invalid plaintext")),
    };
    let key_str = match get_string(&mut env, key_base64) {
        Some(s) => s,
        None => return create_cp_encrypt_result(&mut env, None, None, None, Some("Invalid key")),
    };

    use bittery_crypto_core::encrypt;
    use base64::{engine::general_purpose::STANDARD, Engine};

    let key = match STANDARD.decode(&key_str) {
        Ok(k) => k,
        Err(e) => return create_cp_encrypt_result(&mut env, None, None, None, Some(&format!("Invalid key base64: {}", e))),
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
pub extern "system" fn Java_expo_modules_credentialprovider_crypto_NativeCrypto_nativeDecrypt<'a>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    ciphertext: JString<'a>,
    iv: JString<'a>,
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
    let key_str = match get_string(&mut env, key_base64) {
        Some(s) => s,
        None => return create_cp_result(&mut env, None, Some("Invalid key")),
    };

    use bittery_crypto_core::{decrypt, EncryptedData};
    use base64::{engine::general_purpose::STANDARD, Engine};

    let key = match STANDARD.decode(&key_str) {
        Ok(k) => k,
        Err(e) => return create_cp_result(&mut env, None, Some(&format!("Invalid key base64: {}", e))),
    };

    let data = EncryptedData {
        ciphertext: ciphertext_str,
        iv: iv_str,
        algorithm: "AES-GCM".to_string(),
    };

    match decrypt(&data, &key) {
        Ok(plaintext) => create_cp_result(&mut env, Some(&plaintext), None),
        Err(e) => create_cp_result(&mut env, None, Some(&e.to_string())),
    }
}

// ----------------------------------------------------------------------------
// RSA for Credential Provider
// ----------------------------------------------------------------------------

#[no_mangle]
pub extern "system" fn Java_expo_modules_credentialprovider_crypto_NativeCrypto_nativeRsaEncrypt<'a>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    plaintext: JString<'a>,
    public_key_pem: JString<'a>,
) -> JObject<'a> {
    let plaintext_str = match get_string(&mut env, plaintext) {
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
pub extern "system" fn Java_expo_modules_credentialprovider_crypto_NativeCrypto_nativeRsaDecrypt<'a>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    ciphertext: JString<'a>,
    private_key_pem: JString<'a>,
) -> JObject<'a> {
    let ciphertext_str = match get_string(&mut env, ciphertext) {
        Some(s) => s,
        None => return create_cp_result(&mut env, None, Some("Invalid ciphertext")),
    };
    let pem = match get_string(&mut env, private_key_pem) {
        Some(s) => s,
        None => return create_cp_result(&mut env, None, Some("Invalid private key")),
    };

    use bittery_crypto_core::rsa_decrypt;

    match rsa_decrypt(&ciphertext_str, &pem) {
        Ok(plaintext) => create_cp_result(&mut env, Some(&plaintext), None),
        Err(e) => create_cp_result(&mut env, None, Some(&e.to_string())),
    }
}
