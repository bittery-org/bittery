//! Shared Client Runtime policy.
//!
//! This crate deliberately knows no host framework or binding generator. Platform crates translate
//! its closed protocol and execute primitive ports; they do not own Runtime behavior.

mod protocol;
mod replica;
mod runtime;

pub mod server_contract {
    include!("generated/server.rs");
}

pub use protocol::*;
pub use replica::*;
pub use runtime::*;
