use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use bittery_crypto_api as api;
use bittery_crypto_core as core;
use core::srp6a::{HashAlgorithm, PrimeGroup, SrpServer};
use p256::ecdsa::{signature::Verifier, Signature, SigningKey, VerifyingKey};
use std::future::Future;

fn block_on<T>(future: impl Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(future)
}

fn context() -> api::EncryptionContext {
    api::EncryptionContext {
        vault_id: "vault-1".into(),
        entity_id: "item-7".into(),
        entity_type: "item".into(),
        version: 3,
        user_id: "user-9".into(),
    }
}

#[test]
fn rsa_member_wrapper_opens_through_core_and_existing_api_with_both_private_key_envelopes() {
    let pair = core::generate_rsa_key_pair().unwrap();
    let key = [23; 32];
    let wrapping_key = [7; 32];
    let ciphertext = core::encrypt_vault_key_for_member(&key, &pair.public_key).unwrap();
    for scoped in [false, true] {
        let api_context = scoped.then(context);
        let core_context = api_context.clone().map(|value| core::AadContext {
            vault_id: value.vault_id,
            entity_id: value.entity_id,
            entity_type: value.entity_type,
            version: value.version,
            user_id: value.user_id,
        });
        let envelope = match &core_context {
            Some(context) => core::encrypt_with_aad(&pair.private_key, &wrapping_key, context),
            None => core::encrypt(&pair.private_key, &wrapping_key),
        }
        .unwrap();
        assert_eq!(
            core::decrypt_rsa_wrapped_key(
                &ciphertext,
                &envelope,
                &wrapping_key,
                core_context.as_ref()
            )
            .unwrap(),
            key
        );
        let api_key = block_on(api::import_key(wrapping_key.to_vec())).unwrap();
        let restored = block_on(api::decrypt_rsa_wrapped_key(
            ciphertext.clone(),
            api::EncryptedData {
                ciphertext: envelope.ciphertext.clone(),
                iv: envelope.iv.clone(),
                algorithm: envelope.algorithm.clone(),
            },
            api_key,
            api_context,
        ))
        .unwrap();
        assert_eq!(block_on(api::export_key(restored)).unwrap(), key);
        assert!(core::decrypt_rsa_wrapped_key(
            &ciphertext,
            &envelope,
            &[99; 32],
            core_context.as_ref()
        )
        .is_err());
        let short = core::rsa_encrypt(&BASE64.encode([1; 31]), &pair.public_key).unwrap();
        assert!(matches!(
            core::decrypt_rsa_wrapped_key(&short, &envelope, &wrapping_key, core_context.as_ref()),
            Err(core::CryptoError::InvalidKeyLength {
                expected: 32,
                actual: 31
            })
        ));
    }
}

#[test]
fn fixed_aes_256_gcm_aad_vector_is_stable_and_opens_through_both_layers() {
    let key: Vec<u8> = (0..32).collect();
    let iv: Vec<u8> = (16..28).collect();
    let aad = b"vault-1\0item-7\0item\x003\0user-9";
    let ciphertext = Aes256Gcm::new_from_slice(&key)
        .unwrap()
        .encrypt(
            &Nonce::try_from(iv.as_slice()).unwrap(),
            Payload {
                msg: b"persisted format vector",
                aad,
            },
        )
        .unwrap();

    assert_eq!(
        BASE64.encode(&ciphertext),
        "DZvqZSC6TtauVW5yfRQIJ/cmK21vrSX/QBfIh9B4aryoGz+dVRQ6"
    );
    assert_eq!(BASE64.encode(&iv), "EBESExQVFhcYGRob");

    let data = api::EncryptedData {
        ciphertext: BASE64.encode(ciphertext),
        iv: BASE64.encode(iv),
        algorithm: "AES-GCM-AAD-V1".into(),
    };
    let handle = block_on(api::import_key(key.clone())).unwrap();
    assert_eq!(
        block_on(api::decrypt(data.clone(), handle, Some(context()))).unwrap(),
        "persisted format vector"
    );
    let core_data = core::EncryptedData {
        ciphertext: data.ciphertext,
        iv: data.iv,
        algorithm: data.algorithm,
    };
    let core_context = core::AadContext {
        vault_id: "vault-1".into(),
        entity_id: "item-7".into(),
        entity_type: "item".into(),
        version: 3,
        user_id: "user-9".into(),
    };
    assert_eq!(
        core::decrypt_with_aad(&core_data, &key, &core_context).unwrap(),
        "persisted format vector"
    );
}

#[test]
fn attachment_move_transcrypt_preserves_the_existing_envelope_format() {
    use core::attachment_move::{
        AttachmentBlobScope, AttachmentEnvelopeScanner, AttachmentMoveTranscryptor,
        AttachmentPublicationIdentity,
    };

    // Produced independently with Node's `crypto.createCipheriv("aes-256-gcm", ...)`.
    const SOURCE: &[u8] = br#"{"ciphertext":"4uwgK6vmWFzA3ZgI1V2KRmHobkD+uObElS9n8YPj5Vyz4YaqbrrJXQFo1qAWgGbq4Q==","iv":"MzMzMzMzMzMzMzMz","algorithm":"AES-GCM-AAD-V1"}"#;
    const TARGET: &[u8] = br#"{"ciphertext":"9GDXDoNXzvLHwClFUKu+r3apkmO+x94YVjtMfhKvFAGTwySZr7tzjGWZggILfgXtCw==","iv":"RERERERERERERERE","algorithm":"AES-GCM-AAD-V1"}"#;
    let scope = |vault_id: &str| {
        AttachmentBlobScope::new(vault_id.into(), "attachment-7".into(), "user-9".into())
    };

    let mut scanner = AttachmentEnvelopeScanner::new();
    for chunk in SOURCE.chunks(7) {
        scanner.push(chunk).unwrap();
    }
    let mut transcryptor = AttachmentMoveTranscryptor::new_with_test_iv_and_identity(
        scanner.finish().unwrap(),
        [0x11; 32],
        scope("vault-source"),
        [0x22; 32],
        scope("vault-target"),
        AttachmentPublicationIdentity::new(
            "account-vector".into(),
            "user-9".into(),
            "operation-vector".into(),
            "attachment-7".into(),
        )
        .unwrap(),
        [0x44; 12],
    )
    .unwrap();
    let mut target = Vec::new();
    for chunk in SOURCE.chunks(11) {
        target.extend(transcryptor.push(chunk).unwrap());
    }
    target.extend(transcryptor.finish().unwrap().final_chunk);

    assert_eq!(target, TARGET);
}

#[test]
fn attachment_upload_stream_preserves_the_existing_envelope_format() {
    use core::attachment_move::{AttachmentBlobEncryptor, AttachmentBlobScope};

    // Produced independently with Node's `crypto.createCipheriv("aes-256-gcm", ...)` over the
    // historical Base64 plaintext representation.
    const TARGET: &[u8] = br#"{"ciphertext":"8WLjUKtkpbLR4hxKQ5rmrXPnonCTyNFAYQZvS2uVNQ6UcvzhpW2US6fQn+aNZQm+a4Zbk4uY2QD49dBF3TdS8g==","iv":"RERERERERERERERE","algorithm":"AES-GCM-AAD-V1"}"#;
    let plaintext = b"raw attachment bytes\0across chunks";
    let mut encryptor = AttachmentBlobEncryptor::new_with_test_iv(
        [0x22; 32],
        AttachmentBlobScope::new(
            "vault-target".into(),
            "attachment-7".into(),
            "user-9".into(),
        ),
        [0x44; 12],
    )
    .unwrap();
    let mut target = encryptor.push(&plaintext[..5]).unwrap();
    target.extend(encryptor.push(&plaintext[5..19]).unwrap());
    target.extend(encryptor.push(&plaintext[19..]).unwrap());
    target.extend(encryptor.finish().unwrap().final_chunk);
    assert_eq!(target, TARGET);
}

#[test]
fn srp_6a_api_and_core_complete_the_same_session() {
    let password = "correct horse battery staple";
    let registration = block_on(api::generate_srp_registration(password.into())).unwrap();
    let client_ephemeral = block_on(api::generate_client_ephemeral()).unwrap();
    let server = SrpServer::new(HashAlgorithm::Sha256, PrimeGroup::G4096);
    let server_ephemeral = server.generate_ephemeral(&registration.verifier).unwrap();
    let client_session = block_on(api::derive_client_session(
        client_ephemeral.secret,
        api::SrpServerChallenge {
            salt: registration.salt.clone(),
            server_public_key: server_ephemeral.public.clone(),
        },
        password.into(),
    ))
    .unwrap();
    let server_session = server
        .derive_session(
            &server_ephemeral.secret,
            &client_ephemeral.public_key,
            &registration.salt,
            "",
            &registration.verifier,
            &client_session.proof,
        )
        .unwrap();

    assert_eq!(client_session.key, server_session.key);
    block_on(api::verify_server_session(
        client_ephemeral.public_key,
        client_session,
        server_session.proof.clone(),
    ))
    .unwrap();
}

#[test]
fn srp_password_preserves_the_auth_key_utf8_contract() {
    let auth_key = block_on(api::import_key(
        b"0123456789abcdef0123456789abcdef".to_vec(),
    ))
    .unwrap();

    assert_eq!(
        block_on(api::derive_srp_password(auth_key)).unwrap(),
        "0123456789abcdef0123456789abcdef"
    );
}

#[test]
fn passkey_attestation_and_assertion_match_core_formats() {
    let pair = block_on(api::generate_passkey_keypair()).unwrap();
    assert!(pair.public_key_spki.starts_with("MF"));
    let credential_id = BASE64.encode([0x55; 32]);
    let api_attestation = block_on(api::build_passkey_attestation_object(
        "example.com".into(),
        credential_id.clone(),
        pair.public_key_cose.clone(),
        7,
    ))
    .unwrap();
    let core_attestation = core::build_passkey_attestation_object(
        "example.com",
        &BASE64.decode(credential_id).unwrap(),
        &BASE64.decode(&pair.public_key_cose).unwrap(),
        7,
    )
    .unwrap();
    assert_eq!(
        api_attestation.authenticator_data,
        core_attestation.authenticator_data
    );
    assert_eq!(
        api_attestation.attestation_object,
        core_attestation.attestation_object
    );

    let client_hash = BASE64.encode([0x42; 32]);
    let assertion = block_on(api::sign_passkey_assertion(
        pair.private_key.clone(),
        "example.com".into(),
        client_hash.clone(),
        11,
    ))
    .unwrap();
    let private = p256::SecretKey::from_slice(&BASE64.decode(pair.private_key).unwrap()).unwrap();
    let signing_key = SigningKey::from(private);
    let verifying_key = VerifyingKey::from(&signing_key);
    let mut signed = assertion.authenticator_data.clone();
    signed.extend(BASE64.decode(client_hash).unwrap());
    verifying_key
        .verify(
            &signed,
            &Signature::from_der(&assertion.signature_der).unwrap(),
        )
        .unwrap();
}

#[test]
fn recovery_and_vault_key_wrapping_interoperate_with_core() {
    let master_key = [0x24; 32];
    let recovery_key = core::generate_recovery_key();
    let master_handle = block_on(api::import_key(master_key.to_vec())).unwrap();
    let api_wrapped = block_on(api::encrypt_master_key(
        master_handle,
        recovery_key.clone(),
        "User@Example.com".into(),
    ))
    .unwrap();
    let core_wrapped = core::EncryptedData {
        ciphertext: api_wrapped.ciphertext,
        iv: api_wrapped.iv,
        algorithm: api_wrapped.algorithm,
    };
    assert_eq!(
        core::decrypt_master_key(&core_wrapped, &recovery_key, "user@example.com").unwrap(),
        master_key
    );

    let vault_key = [0x81; 32];
    let vault_handle = block_on(api::import_key(vault_key.to_vec())).unwrap();
    let muk_handle = block_on(api::import_key(master_key.to_vec())).unwrap();
    let wrapped_vault = block_on(api::encrypt_vault_key_with_muk(
        vault_handle,
        muk_handle,
        "vault-fixed".into(),
        "user-fixed".into(),
        9,
    ))
    .unwrap();
    let wrap_context = core::VaultKeyWrapContext::new("vault-fixed", "user-fixed", 9);
    assert_eq!(
        core::decrypt_vault_key_with_muk(&wrapped_vault, &master_key, &wrap_context).unwrap(),
        vault_key
    );
}

#[test]
fn key_handle_destroy_is_idempotent_and_blocks_later_use() {
    let handle = block_on(api::import_key(vec![7; 32])).unwrap();
    block_on(api::destroy_key(handle.clone())).unwrap();
    block_on(api::destroy_key(handle.clone())).unwrap();
    assert!(matches!(
        block_on(api::export_key(handle)),
        Err(api::CryptoError::KeyDestroyed)
    ));
}

#[test]
fn unwrap_key_requires_the_exact_authenticated_context() {
    let wrapping_key = block_on(api::import_key(vec![9; 32])).unwrap();
    let payload = vec![0x42; 32];
    let encryption_context = context();
    let payload_key = block_on(api::import_key(payload.clone())).unwrap();
    let encrypted = block_on(api::wrap_key(
        payload_key,
        wrapping_key.clone(),
        Some(encryption_context.clone()),
    ))
    .unwrap();

    let restored = block_on(api::unwrap_key(
        encrypted.clone(),
        wrapping_key.clone(),
        Some(encryption_context.clone()),
    ))
    .unwrap();
    assert_eq!(block_on(api::export_key(restored)).unwrap(), payload);

    assert!(matches!(
        block_on(api::unwrap_key(
            encrypted,
            wrapping_key,
            Some(api::EncryptionContext {
                entity_id: "other-item".into(),
                ..encryption_context
            }),
        )),
        Err(api::CryptoError::Decryption(_))
    ));
}

#[test]
fn fixed_replica_recovery_v1_stream_vector_opens_and_authenticates_completion() {
    // Produced independently with Node crypto.pbkdf2Sync/createCipheriv, not this encoder.
    // No unrelated CryptoPort member is added: this persisted format is consumed by Rust Runtime.
    let header = hex::decode("4254525245433031000927c0000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262700040000").unwrap();
    let frame = hex::decode("0000002f0000000000be1fd89a4ea4af938a453846f0bcb9306706bd71e8423e6ba15c8cffdc75f4f6ace0f0486b637531197db5a976f8ac").unwrap();
    let terminal =
        hex::decode("0000001c0100000001619f9612016e8a11ec17c0575f1a7d9a3c655a80390008e056a63c02")
            .unwrap();
    let mut decoder =
        core::replica_recovery::RecoveryDecryptor::new("independent vector password", &header)
            .unwrap();
    assert_eq!(
        &*decoder.open_frame(&frame).unwrap().unwrap(),
        b"encrypted recovery vector bytes"
    );
    assert!(
        !decoder.finished(),
        "an authenticated prefix is not a complete backup"
    );
    assert!(decoder.open_frame(&terminal).unwrap().is_none());
    assert!(decoder.finished());
}
