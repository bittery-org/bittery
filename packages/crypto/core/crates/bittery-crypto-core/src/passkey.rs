//! WebAuthn passkey primitives.
//!
//! This module implements the cryptographic parts of a software authenticator
//! for extension-first passkey support.

use ciborium::ser::into_writer;
use ciborium::value::Value;
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use p256::elliptic_curve::Generate;
use p256::SecretKey;
use rand::Rng;
use sha2::{Digest, Sha256};

use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::error::CryptoError;
use crate::system_rng;

/// Bittery fixed AAGUID for extension passkeys.
pub const PASSKEY_AAGUID: [u8; 16] = [
    0xf2, 0x86, 0xf8, 0xf3, 0xd4, 0xcb, 0x4f, 0x75, 0xbe, 0xc1, 0xfb, 0x7a, 0x02, 0x9e, 0xa6, 0x57,
];

/// User Presence
pub const FLAG_UP: u8 = 0x01;
/// User Verification
pub const FLAG_UV: u8 = 0x04;
/// Backup Eligibility
pub const FLAG_BE: u8 = 0x08;
/// Backup State
pub const FLAG_BS: u8 = 0x10;
/// Attested credential data included
pub const FLAG_AT: u8 = 0x40;

/// Generated passkey key material.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct PasskeyKeypair {
    /// 32-byte P-256 private scalar.
    pub private_key: [u8; 32],
    /// CBOR-encoded COSE public key (EC2, ES256).
    pub public_key_cose: Vec<u8>,
    /// DER-encoded SubjectPublicKeyInfo public key for WebAuthn JSON (`response.publicKey`).
    pub public_key_spki: Vec<u8>,
}

// Hand-written so that `{:?}` (or a stray `dbg!`) can never print the P-256
// private scalar. A derived `Debug` would.
impl std::fmt::Debug for PasskeyKeypair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PasskeyKeypair")
            .field("private_key", &"[redacted]")
            .field("public_key_cose", &self.public_key_cose)
            .field("public_key_spki", &self.public_key_spki)
            .finish()
    }
}

/// Attested credential data block for registration.
#[derive(Clone, Debug)]
pub struct AttestedCredentialData {
    pub aaguid: [u8; 16],
    pub credential_id: Vec<u8>,
    pub credential_public_key: Vec<u8>,
}

/// Registration output bytes.
#[derive(Clone, Debug)]
pub struct PasskeyAttestation {
    pub authenticator_data: Vec<u8>,
    pub attestation_object: Vec<u8>,
}

/// Assertion output bytes.
#[derive(Clone, Debug)]
pub struct PasskeyAssertion {
    pub authenticator_data: Vec<u8>,
    pub signature_der: Vec<u8>,
}

/// Generate a P-256 keypair for WebAuthn and return private key + COSE public key.
pub fn generate_passkey_keypair() -> Result<PasskeyKeypair, CryptoError> {
    // `SigningKey::random` was deprecated in ecdsa 0.17 in favour of the
    // `Generate` trait; `generate_from_rng` is the same operation over the same
    // OS entropy source.
    let mut rng = system_rng();
    let signing_key = SigningKey::generate_from_rng(&mut rng);
    let private_key: [u8; 32] = signing_key.to_bytes().into();

    // `to_encoded_point` was renamed `to_sec1_point` in ecdsa 0.17; the return
    // type is still a SEC1 `EncodedPoint`, and `false` still means uncompressed.
    let encoded = signing_key.verifying_key().to_sec1_point(false);
    let x = encoded
        .x()
        .ok_or_else(|| CryptoError::InvalidInput("Missing P-256 x coordinate".to_string()))?;
    let y = encoded
        .y()
        .ok_or_else(|| CryptoError::InvalidInput("Missing P-256 y coordinate".to_string()))?;
    let public_key_cose = encode_cose_public_key(x, y)?;
    let public_key_spki = encode_spki_public_key(x, y)?;

    Ok(PasskeyKeypair {
        private_key,
        public_key_cose,
        public_key_spki,
    })
}

/// Generate a random 32-byte credential ID.
pub fn generate_credential_id() -> [u8; 32] {
    let mut credential_id = [0u8; 32];
    system_rng().fill_bytes(&mut credential_id);
    credential_id
}

/// Encode a P-256 public key into COSE_Key format.
///
/// COSE map fields:
/// - `1: 2` (kty = EC2)
/// - `3: -7` (alg = ES256)
/// - `-1: 1` (crv = P-256)
/// - `-2: x`
/// - `-3: y`
pub fn encode_cose_public_key(x: &[u8], y: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if x.len() != 32 || y.len() != 32 {
        return Err(CryptoError::InvalidInput(
            "P-256 coordinates must be 32 bytes".to_string(),
        ));
    }

    let cose_key = Value::Map(vec![
        (Value::Integer(1_i64.into()), Value::Integer(2_i64.into())),
        (
            Value::Integer(3_i64.into()),
            Value::Integer((-7_i64).into()),
        ),
        (
            Value::Integer((-1_i64).into()),
            Value::Integer(1_i64.into()),
        ),
        (Value::Integer((-2_i64).into()), Value::Bytes(x.to_vec())),
        (Value::Integer((-3_i64).into()), Value::Bytes(y.to_vec())),
    ]);

    let mut encoded = Vec::new();
    into_writer(&cose_key, &mut encoded).map_err(|error| {
        CryptoError::InvalidInput(format!("Failed to encode COSE public key: {}", error))
    })?;
    Ok(encoded)
}

/// Encode a P-256 public key into DER SubjectPublicKeyInfo (SPKI) format.
///
/// This is required for the WebAuthn JSON `response.publicKey` field used by Chromium.
pub fn encode_spki_public_key(x: &[u8], y: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if x.len() != 32 || y.len() != 32 {
        return Err(CryptoError::InvalidInput(
            "P-256 coordinates must be 32 bytes".to_string(),
        ));
    }

    // SEQUENCE {
    //   SEQUENCE { OID ecPublicKey, OID prime256v1 }
    //   BIT STRING { 0x00 || 0x04 || X || Y }
    // }
    const P256_SPKI_PREFIX: [u8; 26] = [
        0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08,
        0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
    ];

    let mut spki = Vec::with_capacity(P256_SPKI_PREFIX.len() + 65);
    spki.extend_from_slice(&P256_SPKI_PREFIX);
    spki.push(0x04); // uncompressed EC point marker
    spki.extend_from_slice(x);
    spki.extend_from_slice(y);
    Ok(spki)
}

/// Build WebAuthn authenticatorData bytes.
pub fn build_authenticator_data(
    rp_id: &str,
    flags: u8,
    sign_count: u32,
    attested_cred_data: Option<&AttestedCredentialData>,
) -> Result<Vec<u8>, CryptoError> {
    if rp_id.trim().is_empty() {
        return Err(CryptoError::InvalidInput(
            "rpId must not be empty".to_string(),
        ));
    }

    let rp_id_hash = Sha256::digest(rp_id.as_bytes());
    let mut auth_data = Vec::with_capacity(128);
    auth_data.extend_from_slice(&rp_id_hash);
    auth_data.push(flags);
    auth_data.extend_from_slice(&sign_count.to_be_bytes());

    if let Some(attested) = attested_cred_data {
        if attested.credential_id.len() > u16::MAX as usize {
            return Err(CryptoError::InvalidInput(
                "credentialId exceeds u16 length".to_string(),
            ));
        }

        auth_data.extend_from_slice(&attested.aaguid);
        auth_data.extend_from_slice(&(attested.credential_id.len() as u16).to_be_bytes());
        auth_data.extend_from_slice(&attested.credential_id);
        auth_data.extend_from_slice(&attested.credential_public_key);
    }

    Ok(auth_data)
}

/// Build a CBOR attestation object with `fmt = "none"` and empty `attStmt`.
pub fn build_attestation_object(auth_data: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let attestation_object = Value::Map(vec![
        (
            Value::Text("fmt".to_string()),
            Value::Text("none".to_string()),
        ),
        (Value::Text("attStmt".to_string()), Value::Map(vec![])),
        (
            Value::Text("authData".to_string()),
            Value::Bytes(auth_data.to_vec()),
        ),
    ]);

    let mut encoded = Vec::new();
    into_writer(&attestation_object, &mut encoded).map_err(|error| {
        CryptoError::InvalidInput(format!("Failed to encode attestation object: {}", error))
    })?;
    Ok(encoded)
}

/// Build attestation output for registration.
pub fn build_passkey_attestation_object(
    rp_id: &str,
    credential_id: &[u8],
    cose_public_key: &[u8],
    sign_count: u32,
) -> Result<PasskeyAttestation, CryptoError> {
    let attested_data = AttestedCredentialData {
        aaguid: PASSKEY_AAGUID,
        credential_id: credential_id.to_vec(),
        credential_public_key: cose_public_key.to_vec(),
    };

    let flags = FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS | FLAG_AT;
    let authenticator_data =
        build_authenticator_data(rp_id, flags, sign_count, Some(&attested_data))?;
    let attestation_object = build_attestation_object(&authenticator_data)?;

    Ok(PasskeyAttestation {
        authenticator_data,
        attestation_object,
    })
}

/// Sign `authenticatorData || clientDataHash` with a P-256 private key.
pub fn sign_assertion(
    private_key: &[u8],
    authenticator_data: &[u8],
    client_data_hash: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    if private_key.len() != 32 {
        return Err(CryptoError::InvalidKeyLength {
            expected: 32,
            actual: private_key.len(),
        });
    }
    if client_data_hash.len() != 32 {
        return Err(CryptoError::InvalidInput(
            "clientDataHash must be 32 bytes".to_string(),
        ));
    }

    let secret_key = SecretKey::from_slice(private_key).map_err(|error| {
        CryptoError::InvalidInput(format!("Invalid P-256 private key bytes: {}", error))
    })?;
    let signing_key = SigningKey::from(secret_key);

    let mut signed_payload = Vec::with_capacity(authenticator_data.len() + client_data_hash.len());
    signed_payload.extend_from_slice(authenticator_data);
    signed_payload.extend_from_slice(client_data_hash);

    let signature: Signature = signing_key.sign(&signed_payload);
    Ok(signature.to_der().as_bytes().to_vec())
}

/// Build assertion authenticatorData and sign it.
pub fn sign_passkey_assertion(
    private_key: &[u8],
    rp_id: &str,
    client_data_hash: &[u8],
    sign_count: u32,
) -> Result<PasskeyAssertion, CryptoError> {
    let flags = FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS;
    let authenticator_data = build_authenticator_data(rp_id, flags, sign_count, None)?;
    let signature_der = sign_assertion(private_key, &authenticator_data, client_data_hash)?;

    Ok(PasskeyAssertion {
        authenticator_data,
        signature_der,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ciborium::de::from_reader;
    use p256::ecdsa::signature::Verifier;
    use p256::ecdsa::{Signature, VerifyingKey};

    fn find_map_entry<'a>(entries: &'a [(Value, Value)], key: &Value) -> Option<&'a Value> {
        entries
            .iter()
            .find_map(|(entry_key, value)| if entry_key == key { Some(value) } else { None })
    }

    #[test]
    fn test_cose_public_key_encoding_shape() {
        let keypair = generate_passkey_keypair().unwrap();
        let cose: Value = from_reader(keypair.public_key_cose.as_slice()).unwrap();
        let entries = match cose {
            Value::Map(entries) => entries,
            _ => panic!("COSE key is not a map"),
        };

        let kty = find_map_entry(&entries, &Value::Integer(1_i64.into())).unwrap();
        let alg = find_map_entry(&entries, &Value::Integer(3_i64.into())).unwrap();
        let crv = find_map_entry(&entries, &Value::Integer((-1_i64).into())).unwrap();
        let x = find_map_entry(&entries, &Value::Integer((-2_i64).into())).unwrap();
        let y = find_map_entry(&entries, &Value::Integer((-3_i64).into())).unwrap();

        assert_eq!(kty, &Value::Integer(2_i64.into()));
        assert_eq!(alg, &Value::Integer((-7_i64).into()));
        assert_eq!(crv, &Value::Integer(1_i64.into()));
        assert!(matches!(x, Value::Bytes(bytes) if bytes.len() == 32));
        assert!(matches!(y, Value::Bytes(bytes) if bytes.len() == 32));
    }

    #[test]
    fn test_debug_does_not_leak_private_key() {
        let keypair = generate_passkey_keypair().unwrap();
        let rendered = format!("{keypair:?}");

        // Both renderings a derived `Debug` could produce for a `[u8; 32]`.
        let decimal_scalar = format!("{:?}", keypair.private_key);
        let hex_scalar: String = keypair
            .private_key
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        assert!(!rendered.contains(&decimal_scalar));
        assert!(!rendered.contains(&hex_scalar));
        assert!(rendered.contains("[redacted]"));
        // The public halves stay visible — they are not secret and are useful
        // in logs.
        assert!(rendered.contains(&format!("{:?}", keypair.public_key_cose)));
        assert!(rendered.contains(&format!("{:?}", keypair.public_key_spki)));
    }

    #[test]
    fn test_spki_public_key_encoding_shape() {
        let keypair = generate_passkey_keypair().unwrap();
        let spki = &keypair.public_key_spki;
        assert_eq!(spki.len(), 91);
        assert_eq!(
            &spki[0..26],
            &[
                0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06,
                0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
            ]
        );
        assert_eq!(spki[26], 0x04);
    }

    #[test]
    fn test_authenticator_data_assembly_for_registration() {
        let keypair = generate_passkey_keypair().unwrap();
        let credential_id = generate_credential_id();
        let attested = AttestedCredentialData {
            aaguid: PASSKEY_AAGUID,
            credential_id: credential_id.to_vec(),
            credential_public_key: keypair.public_key_cose.clone(),
        };

        let flags = FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS | FLAG_AT;
        let auth_data = build_authenticator_data("example.com", flags, 7, Some(&attested)).unwrap();

        assert_eq!(auth_data[32], flags);
        assert_eq!(&auth_data[33..37], &7_u32.to_be_bytes());

        let expected_hash = Sha256::digest("example.com".as_bytes());
        assert_eq!(&auth_data[0..32], expected_hash.as_slice());

        let expected_len =
            32 + 1 + 4 + 16 + 2 + credential_id.len() + keypair.public_key_cose.len();
        assert_eq!(auth_data.len(), expected_len);
    }

    #[test]
    fn test_attestation_object_cbor_shape() {
        let keypair = generate_passkey_keypair().unwrap();
        let credential_id = generate_credential_id();
        let attestation = build_passkey_attestation_object(
            "example.com",
            &credential_id,
            &keypair.public_key_cose,
            0,
        )
        .unwrap();

        let value: Value = from_reader(attestation.attestation_object.as_slice()).unwrap();
        let entries = match value {
            Value::Map(entries) => entries,
            _ => panic!("attestation object is not a map"),
        };

        let fmt = find_map_entry(&entries, &Value::Text("fmt".to_string())).unwrap();
        let att_stmt = find_map_entry(&entries, &Value::Text("attStmt".to_string())).unwrap();
        let auth_data = find_map_entry(&entries, &Value::Text("authData".to_string())).unwrap();

        assert_eq!(fmt, &Value::Text("none".to_string()));
        assert!(matches!(att_stmt, Value::Map(entries) if entries.is_empty()));
        assert!(
            matches!(auth_data, Value::Bytes(bytes) if bytes == &attestation.authenticator_data)
        );
    }

    #[test]
    fn test_signature_verifies_for_auth_data_plus_client_data_hash() {
        let keypair = generate_passkey_keypair().unwrap();
        let client_data_hash = Sha256::digest(br#"{"type":"webauthn.get"}"#);
        let assertion = sign_passkey_assertion(
            &keypair.private_key,
            "example.com",
            client_data_hash.as_slice(),
            3,
        )
        .unwrap();

        let mut payload = Vec::new();
        payload.extend_from_slice(&assertion.authenticator_data);
        payload.extend_from_slice(client_data_hash.as_slice());

        let secret_key = SecretKey::from_slice(&keypair.private_key).unwrap();
        let signing_key = SigningKey::from(secret_key);
        let verifying_key = VerifyingKey::from(&signing_key);
        let signature = Signature::from_der(&assertion.signature_der).unwrap();

        assert!(verifying_key.verify(&payload, &signature).is_ok());
    }
}
