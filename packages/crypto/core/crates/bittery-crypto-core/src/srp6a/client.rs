//! SRP-6a Client Implementation
//!
//! Client-side operations for Secure Remote Password authentication.

use pbkdf2::pbkdf2_hmac;
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha384, Sha512};

use super::bigint::SrpInt;
use super::params::{get_params, HashAlgorithm, PrimeGroup};
use super::{Ephemeral, Session};
use crate::error::CryptoError;

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
    pub fn derive_private_key(&self, salt: &str, username: &str, password: &str) -> String {
        // Normalize username and password (NFKC)
        let username = username.to_owned(); // TODO: proper NFKC normalization
        let password = password.to_owned();

        // H(I | ':' | p)
        let identity_hash = self.hash_string(&format!("{}:{}", username, password));

        // H(s, H(I | ':' | p))
        let s = SrpInt::from_hex(salt);
        let x = self.hash_values(&[&s, &SrpInt::from_hex(&identity_hash)]);

        x.to_hex()
    }

    /// Derive private key using PBKDF2 (safer method)
    ///
    /// Uses PBKDF2 with the specified hash algorithm and OWASP-recommended iterations
    pub fn derive_safe_private_key(
        &self,
        salt: &str,
        password: &str,
        iterations: Option<u32>,
    ) -> String {
        let iterations = iterations.unwrap_or_else(|| self.hash_algorithm.pbkdf2_iterations());
        let salt_bytes = hex::decode(salt).unwrap_or_default();
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

        hex::encode(derived_key)
    }

    /// Derive verifier from private key: v = g^x mod N
    pub fn derive_verifier(&self, private_key: &str) -> String {
        let x = SrpInt::from_hex(private_key);
        let v = self.g.mod_pow(&x, &self.n);
        v.to_hex()
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
        let a = SrpInt::from_hex(client_secret_ephemeral);
        let big_b = SrpInt::from_hex(server_public_ephemeral);
        let s = SrpInt::from_hex(salt);
        let x = SrpInt::from_hex(private_key);

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

        // Handle potential underflow: (B - k*g^x) mod N
        // We need to ensure we're working with positive numbers
        let b_minus_kg_x = if big_b.value() >= k_g_x.value() {
            big_b.subtract(&k_g_x)
        } else {
            // B - k*g^x + N to make it positive
            big_b.add(&self.n).subtract(&k_g_x)
        };

        let u_x = u.multiply(&x);
        let a_plus_ux = a.add(&u_x);
        let big_s = b_minus_kg_x.mod_pow(&a_plus_ux, &self.n);

        // K = H(S)
        let big_k = self.hash_values(&[&big_s]);

        // M = H(H(N) xor H(g), H(I), s, A, B, K)
        let h_n = self.hash_values(&[&self.n]);
        let h_g = self.hash_values(&[&self.g]);
        let h_n_xor_h_g = h_n.xor(&h_g);
        let h_i = self.hash_string(username);
        let h_i_int = SrpInt::from_hex(&h_i);

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
        let big_a = SrpInt::from_hex(client_public_ephemeral);
        let big_m = SrpInt::from_hex(&client_session.proof);
        let big_k = SrpInt::from_hex(&client_session.key);

        // Expected = H(A, M, K)
        let expected = self.hash_values(&[&big_a, &big_m, &big_k]);
        let actual = SrpInt::from_hex(server_session_proof);

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
            let bytes = hex::decode(&hex).unwrap_or_default();
            combined.extend_from_slice(&bytes);
        }

        let hash = self.hash_bytes(&combined);
        let hash_bytes = self.hash_algorithm.output_size();
        SrpInt::with_length(
            num_bigint::BigUint::from_bytes_be(&hash),
            hash_bytes * 2,
        )
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
        let private_key = client.derive_safe_private_key(&salt, "password123", None);
        let verifier = client.derive_verifier(&private_key);

        // Verifier should be deterministic
        let verifier2 = client.derive_verifier(&private_key);
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
}
