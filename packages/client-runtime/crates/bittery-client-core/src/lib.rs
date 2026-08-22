//! Shared Client Runtime policy.
//!
//! This crate deliberately knows no host framework or binding generator. Platform crates translate
//! its closed protocol and execute primitive ports; they do not own Runtime behavior.

mod protocol;
mod replica;
mod runtime;

#[cfg(test)]
mod tests;

pub mod server_contract {
    include!("generated/server.rs");
}

pub use protocol::{
    AccountId, AccountStatus, CustomFieldKind, ItemProjectionStatus, ItemsProjection,
    LoginCustomField, LoginItemDraft, LoginItemProjection, ObservationRequest, ObservationSink,
    RequestCancellation, RuntimeError, RuntimeErrorCode, RuntimeProjection, RuntimeRequest,
    RuntimeResponse, RuntimeStatusProjection,
};
#[doc(hidden)]
pub use replica::SerializedReplicaExecutor;
pub use runtime::{ObservationHandle, Runtime};
