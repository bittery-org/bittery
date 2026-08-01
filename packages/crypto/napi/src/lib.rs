//! NAPI bindings for Bittery Crypto
//!
//! Exposes the core crypto library to Node.js/Bun via native addons.
//! Optimized for server-side SRP-6a operations.
//!
//! # Wiping key material
//!
//! Rust owns only the copies it makes on this side of the boundary, and those
//! are wiped. Two things are outside its reach:
//!
//! * A `String` argument has already been copied out of the V8 heap by NAPI. The
//!   Rust copy is wiped here; the JavaScript string it was copied from lives in
//!   the garbage-collected V8 heap and cannot be cleared from Rust.
//! * A returned `String` is copied into the V8 heap after this crate hands it
//!   back, so the JavaScript-side value is likewise out of reach. Callers that
//!   want a session key or a secret ephemeral gone have to drop the JS reference
//!   and let V8 collect it.

#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi_derive::napi;
use zeroize::Zeroizing;

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
    // The verifier is password-equivalent, so the Rust-side copy is wiped when
    // this binding returns.
    let verifier = Zeroizing::new(verifier);

    let server = SrpServer::new(HashAlgorithm::Sha256, PrimeGroup::G4096);
    let ephemeral = server
        .generate_ephemeral(&verifier)
        .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;

    // The core's `Ephemeral` is `ZeroizeOnDrop`, so it is wiped when it drops
    // here. The clone below is what NAPI copies into the V8 heap.
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
    // `client_public_ephemeral`, `salt` and `client_session_proof` travel over
    // the wire; the secret ephemeral and the verifier do not.
    let server_secret_ephemeral = Zeroizing::new(server_secret_ephemeral);
    let verifier = Zeroizing::new(verifier);

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

    // The core's `Session` is `ZeroizeOnDrop`, so it is wiped when it drops here.
    // The cloned session key is what NAPI copies into the V8 heap.
    Ok(Session {
        key: session.key.clone(),
        proof: session.proof.clone(),
    })
}

// Tests for SRP-6a are in bittery-crypto-core (packages/crypto/core).
// NAPI crates cannot run `cargo test` because NAPI symbols (napi_delete_reference,
// napi_reference_unref) are provided by Node.js at runtime and unavailable during
// standalone test binary linking.
