//! Desktop host capabilities and assembly for the shared Rust Runtime (ticket 63).
//!
//! `bittery-client-core` owns Runtime behavior; this module connects it to Tauri and the OS.
//!
//! Production caller cutover follows the foundation's acceptance; this module does not start a
//! second Account owner alongside the transitional renderer composition.

#![allow(
    dead_code,
    reason = "ticket 63 composes capabilities before production caller cutover"
)]

mod binary_transfer;
mod biometry;
mod connection;
mod device_lease;
mod file_capabilities;
mod files;
mod http;
mod lease;
mod native;
mod native_source_transport;
mod profile_source;
mod recovery;
mod recovery_files;
mod renderer;
mod storage;
mod vault_image_source;
