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
pub fn generate_server_ephemeral(verifier: String) -> Result<Ephemeral> {
    let server = SrpServer::new(HashAlgorithm::Sha256, PrimeGroup::G4096);
    let ephemeral = server
        .generate_ephemeral(&verifier)
        .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;

    Ok(Ephemeral {
        public: ephemeral.public.clone(),
        secret: ephemeral.secret.clone(),
    })
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
        key: session.key.clone(),
        proof: session.proof.clone(),
    })
}

// Tests for SRP-6a are in bittery-crypto-core (packages/crypto/core).
// NAPI crates cannot run `cargo test` because NAPI symbols (napi_delete_reference,
// napi_reference_unref) are provided by Node.js at runtime and unavailable during
// standalone test binary linking.
