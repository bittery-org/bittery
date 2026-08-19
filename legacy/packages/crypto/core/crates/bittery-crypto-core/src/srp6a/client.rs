//! SRP-6a Client Implementation
//!
//! Client-side operations for Secure Remote Password authentication.

use pbkdf2::pbkdf2_hmac;
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha384, Sha512};
use zeroize::Zeroize;

use super::bigint::SrpInt;
use super::params::{get_params, HashAlgorithm, PrimeGroup};
use super::{Ephemeral, Session};
use crate::error::CryptoError;
use crate::identity::normalize_srp_username;

/// SRP Client for authentication
pub struct SrpClient {
    hash_algorithm: HashAlgorithm,
    #[allow(dead_code)]
    prime_group: PrimeGroup,
    n: SrpInt,
    g: SrpInt,
    hex_length: usize,
}

impl SrpClient {
    /// Create a new SRP client with specified parameters
    pub fn new(hash_algorithm: HashAlgorithm, prime_group: PrimeGroup) -> Self {
        let params = get_params(prime_group);
        let hex_length = params.hex_length;

        Self {
            hash_algorithm,
            prime_group,
            n: SrpInt::with_length(params.n, hex_length),
            g: SrpInt::with_length(params.g, hex_length),
            hex_length,
        }
    }

    /// Generate a random salt for user registration
    pub fn generate_salt(&self) -> String {
        let hash_bytes = self.hash_algorithm.output_size();
        SrpInt::random(hash_bytes).to_hex()
    }

    /// Derive private key using standard SRP formula: x = H(s, H(I | ':' | p))
    ///
    /// Note: This is the traditional SRP method, less secure than PBKDF2 variant
    pub fn derive_private_key(
        &self,
        salt: &str,
        username: &str,
        password: &str,
    ) -> Result<String, CryptoError> {
        let username = normalize_srp_username(username);

        // H(I | ':' | p)
        let identity_hash = self.hash_string(&format!("{}:{}", username, password));

        // H(s, H(I | ':' | p))
        let s = SrpInt::from_hex(salt)?;
        let identity_hash_int = SrpInt::from_hex(&identity_hash)?;
        let x = self.hash_values(&[&s, &identity_hash_int]);

        Ok(x.to_hex())
    }

    /// Derive private key using PBKDF2 (safer method)
    ///
    /// Uses PBKDF2 with the specified hash algorithm and OWASP-recommended iterations
    pub fn derive_safe_private_key(
        &self,
        salt: &str,
        password: &str,
        iterations: Option<u32>,
    ) -> Result<String, CryptoError> {
        let iterations = iterations.unwrap_or_else(|| self.hash_algorithm.pbkdf2_iterations());
        let mut salt_bytes = hex::decode(salt)?;
        let password_bytes = password.as_bytes();

        let key_length = self.hash_algorithm.output_size();
        let mut derived_key = vec![0u8; key_length];

        match self.hash_algorithm {
            HashAlgorithm::Sha1 => {
                pbkdf2_hmac::<Sha1>(password_bytes, &salt_bytes, iterations, &mut derived_key);
            }
            HashAlgorithm::Sha256 => {
                pbkdf2_hmac::<Sha256>(password_bytes, &salt_bytes, iterations, &mut derived_key);
            }
            HashAlgorithm::Sha384 => {
                pbkdf2_hmac::<Sha384>(password_bytes, &salt_bytes, iterations, &mut derived_key);
            }
            HashAlgorithm::Sha512 => {
                pbkdf2_hmac::<Sha512>(password_bytes, &salt_bytes, iterations, &mut derived_key);
            }
        }

        let private_key = hex::encode(&derived_key);
        derived_key.zeroize();
        salt_bytes.zeroize();
        Ok(private_key)
    }

    /// Derive verifier from private key: v = g^x mod N
    pub fn derive_verifier(&self, private_key: &str) -> Result<String, CryptoError> {
        let x = SrpInt::from_hex(private_key)?;
        let v = self.g.mod_pow(&x, &self.n);
        Ok(v.to_hex())
    }

    /// Generate client ephemeral key pair
    ///
    /// Returns (A, a) where A = g^a mod N
    pub fn generate_ephemeral(&self) -> Ephemeral {
        let hash_bytes = self.hash_algorithm.output_size();
        let a = SrpInt::random(hash_bytes);

        // A = g^a mod N
        let big_a = self.g.mod_pow(&a, &self.n);

        Ephemeral {
            secret: a.pad(hash_bytes * 2).to_hex(),
            public: big_a.to_hex(),
        }
    }

    /// Derive session key and proof
    ///
    /// # Arguments
    /// * `client_secret_ephemeral` - Client's secret ephemeral (a)
    /// * `server_public_ephemeral` - Server's public ephemeral (B)
    /// * `salt` - User's salt
    /// * `username` - Username
    /// * `private_key` - User's private key (x)
    ///
    /// # Returns
    /// Session containing shared key (K) and client proof (M1)
    pub fn derive_session(
        &self,
        client_secret_ephemeral: &str,
        server_public_ephemeral: &str,
        salt: &str,
        username: &str,
        private_key: &str,
    ) -> Result<Session, CryptoError> {
        let a = SrpInt::from_hex(client_secret_ephemeral)?;
        let big_b = SrpInt::from_hex(server_public_ephemeral)?;
        let s = SrpInt::from_hex(salt)?;
        let x = SrpInt::from_hex(private_key)?;

        // A = g^a mod N
        let big_a = self.g.mod_pow(&a, &self.n);

        // B % N > 0
        if big_b.modulo(&self.n).is_zero() {
            return Err(CryptoError::InvalidPublicEphemeral);
        }

        // u = H(PAD(A), PAD(B))
        let padded_a = big_a.pad(self.hex_length);
        let padded_b = big_b.pad(self.hex_length);
        let u = self.hash_values(&[&padded_a, &padded_b]);

        // k = H(N, PAD(g))
        let padded_g = self.g.pad(self.hex_length);
        let k = self.hash_values(&[&self.n, &padded_g]);

        // S = (B - k * g^x)^(a + u*x) mod N
        let g_x = self.g.mod_pow(&x, &self.n);
        let k_g_x = k.multiply(&g_x).modulo(&self.n);

        // (B - k*g^x) mod N
        let b_minus_kg_x = big_b.subtract_mod(&k_g_x, &self.n);

        let u_x = u.multiply(&x);
        let a_plus_ux = a.add(&u_x);
        let big_s = b_minus_kg_x.mod_pow(&a_plus_ux, &self.n);

        // K = H(S)
        let big_k = self.hash_values(&[&big_s]);

        // M = H(H(N) xor H(g), H(I), s, A, B, K)
        let h_n = self.hash_values(&[&self.n]);
        let h_g = self.hash_values(&[&self.g]);
        let h_n_xor_h_g = h_n.xor(&h_g);
        let username = normalize_srp_username(username);
        let h_i = self.hash_string(&username);
        let h_i_int = SrpInt::from_hex(&h_i)?;

        let big_m = self.hash_values(&[&h_n_xor_h_g, &h_i_int, &s, &big_a, &big_b, &big_k]);

        Ok(Session {
            key: big_k.to_hex(),
            proof: big_m.to_hex(),
        })
    }

    /// Verify server session proof
    ///
    /// # Arguments
    /// * `client_public_ephemeral` - Client's public ephemeral (A)
    /// * `client_session` - Client's session (K, M1)
    /// * `server_session_proof` - Server's proof (M2)
    pub fn verify_session(
        &self,
        client_public_ephemeral: &str,
        client_session: &Session,
        server_session_proof: &str,
    ) -> Result<(), CryptoError> {
        let big_a = SrpInt::from_hex(client_public_ephemeral)?;
        let big_m = SrpInt::from_hex(&client_session.proof)?;
        let big_k = SrpInt::from_hex(&client_session.key)?;

        // Expected = H(A, M, K)
        let expected = self.hash_values(&[&big_a, &big_m, &big_k]);
        let actual = SrpInt::from_hex(server_session_proof)?;

        if !actual.equals(&expected) {
            return Err(CryptoError::InvalidSessionProof);
        }

        Ok(())
    }

    /// Hash multiple SrpInt values together
    fn hash_values(&self, values: &[&SrpInt]) -> SrpInt {
        // Concatenate all values as bytes
        let mut combined = Vec::new();
        for value in values {
            let hex = value.to_hex();
            let bytes = hex::decode(&hex).expect("SrpInt::to_hex must produce valid hex");
            combined.extend_from_slice(&bytes);
        }

        let hash = self.hash_bytes(&combined);
        let hash_bytes = self.hash_algorithm.output_size();
        SrpInt::with_length(num_bigint::BigUint::from_bytes_be(&hash), hash_bytes * 2)
    }

    /// Hash a string
    fn hash_string(&self, input: &str) -> String {
        let hash = self.hash_bytes(input.as_bytes());
        hex::encode(hash)
    }

    /// Hash raw bytes
    fn hash_bytes(&self, data: &[u8]) -> Vec<u8> {
        match self.hash_algorithm {
            HashAlgorithm::Sha1 => {
                let mut hasher = Sha1::new();
                hasher.update(data);
                hasher.finalize().to_vec()
            }
            HashAlgorithm::Sha256 => {
                let mut hasher = Sha256::new();
                hasher.update(data);
                hasher.finalize().to_vec()
            }
            HashAlgorithm::Sha384 => {
                let mut hasher = Sha384::new();
                hasher.update(data);
                hasher.finalize().to_vec()
            }
            HashAlgorithm::Sha512 => {
                let mut hasher = Sha512::new();
                hasher.update(data);
                hasher.finalize().to_vec()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_salt() {
        let client = SrpClient::new(HashAlgorithm::Sha256, PrimeGroup::G4096);
        let salt1 = client.generate_salt();
        let salt2 = client.generate_salt();

        assert_ne!(salt1, salt2);
        assert_eq!(salt1.len(), 64); // 32 bytes = 64 hex chars
    }

    #[test]
    fn test_derive_verifier() {
        let client = SrpClient::new(HashAlgorithm::Sha256, PrimeGroup::G4096);
        let salt = client.generate_salt();
        let private_key = client
            .derive_safe_private_key(&salt, "password123", None)
            .unwrap();
        let verifier = client.derive_verifier(&private_key).unwrap();

        // Verifier should be deterministic
        let verifier2 = client.derive_verifier(&private_key).unwrap();
        assert_eq!(verifier, verifier2);
    }

    #[test]
    fn test_generate_ephemeral() {
        let client = SrpClient::new(HashAlgorithm::Sha256, PrimeGroup::G4096);
        let ephemeral1 = client.generate_ephemeral();
        let ephemeral2 = client.generate_ephemeral();

        assert_ne!(ephemeral1.public, ephemeral2.public);
        assert_ne!(ephemeral1.secret, ephemeral2.secret);
    }

    #[test]
    fn test_pbkdf2_iterations() {
        assert_eq!(HashAlgorithm::Sha256.pbkdf2_iterations(), 310_000);
        assert_eq!(HashAlgorithm::Sha1.pbkdf2_iterations(), 720_000);
    }

    #[test]
    fn test_derive_safe_private_key_invalid_salt_returns_error() {
        let client = SrpClient::new(HashAlgorithm::Sha256, PrimeGroup::G4096);
        let result = client.derive_safe_private_key("ZZZZ", "password123", None);
        assert!(result.is_err());
    }

    /// Known-answer tests against RFC 5054 Appendix B (and, for the session key
    /// and proofs, RFC 2945 section 3). See `srp6a::test_vectors` for the exact
    /// provenance of every constant used here.
    ///
    /// These matter because the roundtrip tests above only prove that the
    /// client and the server agree with each other; they would keep passing if
    /// a bignum or padding regression moved both sides in the same direction.
    mod rfc_vectors {
        use super::*;
        use crate::srp6a::test_vectors as v;

        fn client() -> SrpClient {
            SrpClient::new(HashAlgorithm::Sha1, PrimeGroup::G1024)
        }

        #[test]
        fn rfc5054_private_key_x_matches_vector() {
            let x = client()
                .derive_private_key(v::SALT, v::USERNAME, v::PASSWORD)
                .unwrap();
            assert_eq!(x, v::X);
        }

        #[test]
        fn rfc5054_verifier_matches_vector() {
            let verifier = client().derive_verifier(v::X).unwrap();
            assert_eq!(verifier, v::VERIFIER);
        }

        #[test]
        fn rfc5054_multiplier_k_matches_vector() {
            let client = client();
            // k = H(N, PAD(g))
            let padded_g = client.g.pad(client.hex_length);
            let k = client.hash_values(&[&client.n, &padded_g]);
            assert_eq!(k.to_hex(), v::K_MULTIPLIER);
        }

        #[test]
        fn rfc5054_client_public_ephemeral_matches_vector() {
            let client = client();
            let a = SrpInt::from_hex(v::CLIENT_SECRET).unwrap();
            // A = g^a mod N
            let big_a = client.g.mod_pow(&a, &client.n);
            assert_eq!(big_a.to_hex(), v::CLIENT_PUBLIC);
        }

        #[test]
        fn rfc5054_scrambling_parameter_u_matches_vector() {
            let client = client();
            let big_a = SrpInt::from_hex(v::CLIENT_PUBLIC).unwrap();
            let big_b = SrpInt::from_hex(v::SERVER_PUBLIC).unwrap();
            // u = H(PAD(A), PAD(B))
            let u =
                client.hash_values(&[&big_a.pad(client.hex_length), &big_b.pad(client.hex_length)]);
            assert_eq!(u.to_hex(), v::U);
        }

        #[test]
        fn rfc5054_session_key_is_hash_of_the_premaster_secret() {
            // Ties the session-key vector back to RFC 5054's published premaster
            // secret, so `SESSION_KEY` is not an unanchored constant: it is
            // exactly H(PAD(S)) for the RFC's S.
            let client = client();
            let big_s = SrpInt::from_hex(v::PREMASTER_SECRET).unwrap();
            assert_eq!(client.hash_values(&[&big_s]).to_hex(), v::SESSION_KEY);
        }

        #[test]
        fn rfc5054_client_session_matches_vectors() {
            // Pins the client-side S = (B - k*g^x)^(a + u*x) mod N, because K is
            // H(PAD(S)) and the previous test anchors K to the RFC's premaster
            // secret.
            let session = client()
                .derive_session(
                    v::CLIENT_SECRET,
                    v::SERVER_PUBLIC,
                    v::SALT,
                    v::USERNAME,
                    v::X,
                )
                .unwrap();

            assert_eq!(session.key, v::SESSION_KEY);
            assert_eq!(session.proof, v::CLIENT_PROOF);
        }

        #[test]
        fn rfc5054_verify_session_accepts_vector_server_proof() {
            let session = Session {
                key: v::SESSION_KEY.to_string(),
                proof: v::CLIENT_PROOF.to_string(),
            };
            client()
                .verify_session(v::CLIENT_PUBLIC, &session, v::SERVER_PROOF)
                .expect("RFC vector server proof must verify");
        }

        #[test]
        fn rfc5054_verify_session_rejects_flipped_server_proof() {
            let session = Session {
                key: v::SESSION_KEY.to_string(),
                proof: v::CLIENT_PROOF.to_string(),
            };
            let mut tampered = v::SERVER_PROOF.to_string();
            tampered.replace_range(0..1, "c"); // 'b' -> 'c'
            let result = client().verify_session(v::CLIENT_PUBLIC, &session, &tampered);
            assert!(matches!(result, Err(CryptoError::InvalidSessionProof)));
        }

        #[test]
        fn k_requires_zero_padded_g() {
            // g = 2 encodes as a single byte, but k = H(N, PAD(g)) hashes it as
            // a full modulus-width value. Dropping the pad silently changes k
            // (and therefore B, S and every proof), so assert both directions.
            let client = client();
            let unpadded_g = SrpInt::from_hex("02").unwrap();
            assert_eq!(unpadded_g.to_hex(), "02");

            let with_pad = client.hash_values(&[&client.n, &client.g.pad(client.hex_length)]);
            let without_pad = client.hash_values(&[&client.n, &unpadded_g]);

            assert_eq!(with_pad.to_hex(), v::K_MULTIPLIER);
            assert_ne!(without_pad.to_hex(), v::K_MULTIPLIER);
        }

        #[test]
        fn hash_output_keeps_its_leading_zero_byte() {
            // The RFC-anchored session key starts with a 0x00 byte. `to_hex`
            // must keep it, otherwise the 20-byte K fed into M1/M2 would shrink
            // to 19 bytes and both proofs would change.
            let client = client();
            let big_s = SrpInt::from_hex(v::PREMASTER_SECRET).unwrap();
            let big_k = client.hash_values(&[&big_s]);

            let hex = big_k.to_hex();
            assert_eq!(hex.len(), 40);
            assert!(hex.starts_with("01"));
            assert_eq!(hex::decode(&hex).unwrap().len(), 20);
        }
    }
}
