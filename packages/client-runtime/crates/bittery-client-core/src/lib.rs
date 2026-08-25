//! Shared Client Runtime policy.
//!
//! This crate deliberately knows no host framework or binding generator. Platform crates translate
//! its closed protocol and execute primitive ports; they do not own Runtime behavior.

// Ticket 19 deliberately lands the closed storage vocabulary before wiring authentication to it.
#[allow(dead_code)]
mod platform_storage;
// Ticket 19 lands the primitive host seam before authentication starts constructing requests.
#[allow(dead_code)]
mod http_transport;
// Ticket 19 keeps Server authentication policy behind one typed Rust-owned HTTP seam.
#[allow(dead_code)]
mod auth_http;
// Ticket 19 keeps the complete unchanged SRP/KDF ceremony behind one private deep module.
#[allow(dead_code)]
mod authentication;
// Ticket 19 keeps compatibility wrapping and time conversion private until Account installation.
#[allow(
    dead_code,
    unused_imports,
    reason = "Ticket 28 lands artifact durability before the preparation worker consumes it"
)]
mod attachment_artifact_store;
#[allow(dead_code)]
mod authentication_installation;
// Ticket 21 slice B needs a wall clock the Runtime can wait on, not only read.
mod device_timer;
mod protocol;
mod replica;
mod runtime;
mod wire;

#[cfg(test)]
mod test_fixtures;
#[cfg(test)]
mod tests;

pub mod server_contract {
    include!("generated/server.rs");
}

#[doc(hidden)]
pub use auth_http::{AuthClientConfig, ClientPlatform};
#[cfg(feature = "http-transport-contract-schema")]
#[doc(hidden)]
pub use http_transport::http_transport_contract_schema;
#[doc(hidden)]
pub use http_transport::SerializedHttpExecutor;

#[cfg(not(target_arch = "wasm32"))]
#[doc(hidden)]
pub use attachment_artifact_store::SqliteAttachmentArtifactStore;
#[doc(hidden)]
pub use attachment_artifact_store::{
    ArtifactChunkWrite, ArtifactPublication, AttachmentArtifactOwner, AttachmentArtifactStore,
    AttachmentArtifactStoreRequest, AttachmentArtifactStoreResponse, ExclusiveStartupBoundary,
    ProvisionalAttachmentArtifactRecovery, ProvisionalAttachmentArtifactScope,
    ProvisionalAttachmentArtifactStore, ProvisionalAttachmentArtifactStoreRequest,
    ProvisionalAttachmentArtifactStoreResponse, ProvisionalAttachmentArtifactWriter,
    PublishedArtifactChunk, ARTIFACT_CHUNK_BYTES,
};
#[cfg(feature = "platform-storage-contract-schema")]
#[doc(hidden)]
pub use platform_storage::platform_storage_contract_schema;
#[doc(hidden)]
pub use platform_storage::SerializedPlatformStorageExecutor;
#[cfg(feature = "runtime-protocol-contract-schema")]
#[doc(hidden)]
pub use protocol::runtime_protocol_contract_schema;
pub use protocol::{
    AccountAccessState, AccountId, AccountStatus, AccountWaitingReason, AttachmentProjection,
    CustomFieldKind, ItemProjectionStatus, ItemsProjection, LoginCustomField, LoginItemDraft,
    LoginItemProjection, ObservationRequest, ObservationSink, RequestCancellation, RuntimeError,
    RuntimeErrorCode, RuntimeOutcome, RuntimeProjection, RuntimeRequest, RuntimeResponse,
    RuntimeStatusProjection, VaultProjection, VaultProjectionRole, VaultProjectionType,
};
#[cfg(feature = "persistence-contract-schema")]
#[doc(hidden)]
pub use replica::persistence_contract_schema;
#[cfg(all(feature = "replica-conformance", not(target_arch = "wasm32")))]
#[doc(hidden)]
pub use replica::replica_conformance::generate_replica_conformance_corpus;
#[doc(hidden)]
pub use replica::SerializedReplicaExecutor;
#[cfg(not(target_arch = "wasm32"))]
#[doc(hidden)]
pub use replica::SqliteReplica;
pub use runtime::{ObservationHandle, Runtime};
