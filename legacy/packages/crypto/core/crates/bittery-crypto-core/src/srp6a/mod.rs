//! SRP-6a Protocol Implementation
//!
//! Implements the Secure Remote Password protocol (RFC 2945, RFC 5054)
//! for zero-knowledge password authentication.

mod bigint;
mod client;
mod params;
mod server;
#[cfg(test)]
mod test_vectors;

pub use client::SrpClient;
pub use params::{HashAlgorithm, PrimeGroup};
pub use server::SrpServer;
use zeroize::{Zeroize, ZeroizeOnDrop};

/// Ephemeral key pair (public and secret)
#[derive(Debug, Clone, Zeroize, ZeroizeOnDrop)]
pub struct Ephemeral {
    /// Public ephemeral value (hex-encoded)
    pub public: String,
    /// Secret ephemeral value (hex-encoded)
    pub secret: String,
}

/// Session containing shared key and proof
#[derive(Debug, Clone, Zeroize, ZeroizeOnDrop)]
pub struct Session {
    /// Shared session key (hex-encoded)
    pub key: String,
    /// Session proof (hex-encoded)
    pub proof: String,
}
