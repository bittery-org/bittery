//! SRP-6a Server Implementation
//!
//! Server-side operations for Secure Remote Password authentication.

use sha1::Sha1;
use sha2::{Digest, Sha256, Sha384, Sha512};

use super::bigint::SrpInt;
use super::params::{get_params, HashAlgorithm, PrimeGroup};
use super::{Ephemeral, Session};
use crate::error::CryptoError;

/// SRP Server for authentication
pub struct SrpServer {
    hash_algorithm: HashAlgorithm,
    #[allow(dead_code)]
    prime_group: PrimeGroup,
    n: SrpInt,
    g: SrpInt,
    hex_length: usize,
}

impl SrpServer {
    /// Create a new SRP server with specified parameters
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

    /// Generate server ephemeral key pair
    ///
    /// # Arguments
    /// * `verifier` - User's verifier (v)
    ///
    /// # Returns
    /// Server ephemeral (B, b) where B = kv + g^b mod N
    pub fn generate_ephemeral(&self, verifier: &str) -> Result<Ephemeral, CryptoError> {
        let v = SrpInt::from_hex(verifier)?;
        let hash_bytes = self.hash_algorithm.output_size();
        let b = SrpInt::random(hash_bytes);

        // k = H(N, PAD(g))
        let padded_g = self.g.pad(self.hex_length);
        let k = self.hash_values(&[&self.n, &padded_g]);

        // B = kv + g^b mod N
        let kv = k.multiply(&v).modulo(&self.n);
        let g_b = self.g.mod_pow(&b, &self.n);
        let big_b = kv.add(&g_b).modulo(&self.n);

        Ok(Ephemeral {
            secret: b.pad(hash_bytes * 2).to_hex(),
            public: big_b.to_hex(),
        })
    }

    /// Derive session key and verify client proof
    ///
    /// # Arguments
    /// * `server_secret_ephemeral` - Server's secret ephemeral (b)
    /// * `client_public_ephemeral` - Client's public ephemeral (A)
    /// * `salt` - User's salt
    /// * `username` - Username
    /// * `verifier` - User's verifier (v)
    /// * `client_session_proof` - Client's proof (M1)
    ///
    /// # Returns
    /// Session containing shared key (K) and server proof (M2)
    pub fn derive_session(
        &self,
        server_secret_ephemeral: &str,
        client_public_ephemeral: &str,
        salt: &str,
        username: &str,
        verifier: &str,
        client_session_proof: &str,
    ) -> Result<Session, CryptoError> {
        let b = SrpInt::from_hex(server_secret_ephemeral)?;
        let big_a = SrpInt::from_hex(client_public_ephemeral)?;
        let s = SrpInt::from_hex(salt)?;
        let v = SrpInt::from_hex(verifier)?;

        // k = H(N, PAD(g))
        let padded_g = self.g.pad(self.hex_length);
        let k = self.hash_values(&[&self.n, &padded_g]);

        // B = kv + g^b mod N
        let kv = k.multiply(&v).modulo(&self.n);
        let g_b = self.g.mod_pow(&b, &self.n);
        let big_b = kv.add(&g_b).modulo(&self.n);

        // A % N > 0
        if big_a.modulo(&self.n).is_zero() {
            return Err(CryptoError::InvalidPublicEphemeral);
        }

        // u = H(PAD(A), PAD(B))
        let padded_a = big_a.pad(self.hex_length);
        let padded_b = big_b.pad(self.hex_length);
        let u = self.hash_values(&[&padded_a, &padded_b]);

        // S = (A * v^u)^b mod N
        let v_u = v.mod_pow(&u, &self.n);
        let a_v_u = big_a.multiply(&v_u).modulo(&self.n);
        let big_s = a_v_u.mod_pow(&b, &self.n);

        // K = H(S)
        let big_k = self.hash_values(&[&big_s]);

        // M = H(H(N) xor H(g), H(I), s, A, B, K)
        let h_n = self.hash_values(&[&self.n]);
        let h_g = self.hash_values(&[&self.g]);
        let h_n_xor_h_g = h_n.xor(&h_g);
        let h_i = self.hash_string(username);
        let h_i_int = SrpInt::from_hex(&h_i)?;

        let expected_m = self.hash_values(&[&h_n_xor_h_g, &h_i_int, &s, &big_a, &big_b, &big_k]);

        // Verify client proof
        let actual_m = SrpInt::from_hex(client_session_proof)?;
        if !actual_m.equals(&expected_m) {
            return Err(CryptoError::InvalidSessionProof);
        }

        // P = H(A, M, K)
        let big_p = self.hash_values(&[&big_a, &expected_m, &big_k]);

        Ok(Session {
            key: big_k.to_hex(),
            proof: big_p.to_hex(),
        })
    }

    /// Hash multiple SrpInt values together
    fn hash_values(&self, values: &[&SrpInt]) -> SrpInt {
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
    use super::super::client::SrpClient;
    use super::*;

    #[test]
    fn test_full_srp_flow() {
        let hash_algorithm = HashAlgorithm::Sha256;
        let prime_group = PrimeGroup::G4096;

        let client = SrpClient::new(hash_algorithm, prime_group);
        let server = SrpServer::new(hash_algorithm, prime_group);

        let username = "testuser";
        let password = "secretpassword123";

        // Registration: Client generates salt and verifier
        let salt = client.generate_salt();
        let private_key = client
            .derive_safe_private_key(&salt, password, Some(1000))
            .unwrap(); // Low iterations for testing
        let verifier = client.derive_verifier(&private_key).unwrap();

        // Login Step 1: Client generates ephemeral
        let client_ephemeral = client.generate_ephemeral();

        // Login Step 2: Server generates ephemeral
        let server_ephemeral = server.generate_ephemeral(&verifier).unwrap();

        // Login Step 3: Client derives session
        let client_session = client
            .derive_session(
                &client_ephemeral.secret,
                &server_ephemeral.public,
                &salt,
                username,
                &private_key,
            )
            .expect("Client session derivation failed");

        // Login Step 4: Server verifies client proof and derives session
        let server_session = server
            .derive_session(
                &server_ephemeral.secret,
                &client_ephemeral.public,
                &salt,
                username,
                &verifier,
                &client_session.proof,
            )
            .expect("Server session derivation failed");

        // Both should have the same session key
        assert_eq!(client_session.key, server_session.key);

        // Login Step 5: Client verifies server proof
        client
            .verify_session(
                &client_ephemeral.public,
                &client_session,
                &server_session.proof,
            )
            .expect("Server proof verification failed");
    }

    #[test]
    fn test_wrong_password_fails() {
        let hash_algorithm = HashAlgorithm::Sha256;
        let prime_group = PrimeGroup::G4096;

        let client = SrpClient::new(hash_algorithm, prime_group);
        let server = SrpServer::new(hash_algorithm, prime_group);

        let username = "testuser";
        let correct_password = "correctpassword";
        let wrong_password = "wrongpassword";

        // Register with correct password
        let salt = client.generate_salt();
        let correct_private_key = client
            .derive_safe_private_key(&salt, correct_password, Some(1000))
            .unwrap();
        let verifier = client.derive_verifier(&correct_private_key).unwrap();

        // Try to login with wrong password
        let wrong_private_key = client
            .derive_safe_private_key(&salt, wrong_password, Some(1000))
            .unwrap();
        let client_ephemeral = client.generate_ephemeral();
        let server_ephemeral = server.generate_ephemeral(&verifier).unwrap();

        let client_session = client
            .derive_session(
                &client_ephemeral.secret,
                &server_ephemeral.public,
                &salt,
                username,
                &wrong_private_key,
            )
            .expect("Client session derivation should succeed");

        // Server should reject the proof
        let result = server.derive_session(
            &server_ephemeral.secret,
            &client_ephemeral.public,
            &salt,
            username,
            &verifier,
            &client_session.proof,
        );

        assert!(matches!(result, Err(CryptoError::InvalidSessionProof)));
    }

    #[test]
    fn test_generate_ephemeral_invalid_verifier_returns_error() {
        let server = SrpServer::new(HashAlgorithm::Sha256, PrimeGroup::G4096);
        let result = server.generate_ephemeral("ZZZZ");
        assert!(result.is_err());
    }
}
