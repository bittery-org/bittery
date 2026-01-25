//! NAPI bindings for Bittery Crypto
//!
//! Exposes the core crypto library to Node.js/Bun via native addons.
//! Optimized for server-side SRP-6a operations.

#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi_derive::napi;

use bittery_crypto_core::srp6a::{HashAlgorithm, PrimeGroup, SrpServer};

// ============================================================================
// Type Definitions
// ============================================================================

#[napi(object)]
pub struct Ephemeral {
    pub public: String,
    pub secret: String,
}

#[napi(object)]
pub struct Session {
    pub key: String,
    pub proof: String,
}

// ============================================================================
// SRP-6a Server Functions
// ============================================================================

/// Generate server ephemeral key pair for SRP authentication
///
/// # Arguments
/// * `verifier` - User's SRP verifier (stored during registration)
///
/// # Returns
/// Server ephemeral containing public key (sent to client) and secret (kept server-side)
#[napi]
pub fn generate_server_ephemeral(verifier: String) -> Ephemeral {
    let server = SrpServer::new(HashAlgorithm::Sha256, PrimeGroup::G4096);
    let ephemeral = server.generate_ephemeral(&verifier);

    Ephemeral {
        public: ephemeral.public,
        secret: ephemeral.secret,
    }
}

/// Derive server session and verify client proof
///
/// # Arguments
/// * `server_secret_ephemeral` - Server's secret ephemeral (from generate_server_ephemeral)
/// * `client_public_ephemeral` - Client's public ephemeral (received from client)
/// * `salt` - User's SRP salt (stored during registration)
/// * `verifier` - User's SRP verifier (stored during registration)
/// * `client_session_proof` - Client's proof (M1, received from client)
///
/// # Returns
/// Session containing shared key and server proof (M2, sent to client for verification)
///
/// # Errors
/// Returns error if client proof is invalid
#[napi]
pub fn derive_server_session(
    server_secret_ephemeral: String,
    client_public_ephemeral: String,
    salt: String,
    verifier: String,
    client_session_proof: String,
) -> Result<Session> {
    let server = SrpServer::new(HashAlgorithm::Sha256, PrimeGroup::G4096);

    // Note: username is empty string when using deriveSafePrivateKey
    // This matches the JS implementation behavior
    let session = server
        .derive_session(
            &server_secret_ephemeral,
            &client_public_ephemeral,
            &salt,
            "", // Empty username when using deriveSafePrivateKey
            &verifier,
            &client_session_proof,
        )
        .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;

    Ok(Session {
        key: session.key,
        proof: session.proof,
    })
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use bittery_crypto_core::srp6a::SrpClient;

    #[test]
    fn test_full_srp_flow() {
        // Setup
        let client = SrpClient::new(HashAlgorithm::Sha256, PrimeGroup::G4096);

        let password = "testpassword123";

        // Registration: Client generates salt and verifier
        let salt = client.generate_salt();
        let private_key = client.derive_safe_private_key(&salt, password, Some(1000));
        let verifier = client.derive_verifier(&private_key);

        // Login Step 1: Client generates ephemeral
        let client_ephemeral = client.generate_ephemeral();

        // Login Step 2: Server generates ephemeral using NAPI function
        let server_ephemeral = generate_server_ephemeral(verifier.clone());

        // Login Step 3: Client derives session
        let client_session = client
            .derive_session(
                &client_ephemeral.secret,
                &server_ephemeral.public,
                &salt,
                "", // Empty username
                &private_key,
            )
            .expect("Client session derivation should succeed");

        // Login Step 4: Server verifies client proof using NAPI function
        let server_session = derive_server_session(
            server_ephemeral.secret,
            client_ephemeral.public.clone(),
            salt,
            verifier,
            client_session.proof.clone(),
        )
        .expect("Server session derivation should succeed");

        // Both should have the same session key
        assert_eq!(client_session.key, server_session.key);

        // Login Step 5: Client verifies server proof
        client
            .verify_session(
                &client_ephemeral.public,
                &client_session,
                &server_session.proof,
            )
            .expect("Server proof verification should succeed");
    }

    #[test]
    fn test_wrong_password_fails() {
        let client = SrpClient::new(HashAlgorithm::Sha256, PrimeGroup::G4096);

        let correct_password = "correctpassword";
        let wrong_password = "wrongpassword";

        // Register with correct password
        let salt = client.generate_salt();
        let correct_private_key = client.derive_safe_private_key(&salt, correct_password, Some(1000));
        let verifier = client.derive_verifier(&correct_private_key);

        // Try to login with wrong password
        let wrong_private_key = client.derive_safe_private_key(&salt, wrong_password, Some(1000));
        let client_ephemeral = client.generate_ephemeral();
        let server_ephemeral = generate_server_ephemeral(verifier.clone());

        let client_session = client
            .derive_session(
                &client_ephemeral.secret,
                &server_ephemeral.public,
                &salt,
                "",
                &wrong_private_key,
            )
            .expect("Client session derivation should succeed");

        // Server should reject the proof
        let result = derive_server_session(
            server_ephemeral.secret,
            client_ephemeral.public,
            salt,
            verifier,
            client_session.proof,
        );

        assert!(result.is_err());
    }
}
