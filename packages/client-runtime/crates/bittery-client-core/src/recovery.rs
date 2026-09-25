//! Account-scoped preservation and repair policy. The host executes only the closed physical port.
pub(crate) mod control;

pub(crate) mod archive;
mod artifacts;
pub(crate) mod capture;
pub(crate) mod limits;
mod protected_images;
pub(crate) mod repair;
mod report;
pub(crate) mod transfer;

#[cfg(not(target_arch = "wasm32"))]
pub(crate) mod sqlite;

#[cfg(test)]
mod repair_tests;

#[cfg(test)]
mod transfer_tests;
